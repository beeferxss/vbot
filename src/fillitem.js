'use strict';

// The bot's own command block: a one-block mini core.
//
// It is placed once, from a creative slot packet that already holds the fill and
// `auto: 1b` in its block entity data, and then it is never broken: every later
// change is written into it with `update_command_block`, exactly how the main
// core's blocks are written, and the block runs the command against the main
// core itself. The core's blocks are therefore never edited directly while this
// block stands.
//
// The block is placed again when the bot has moved more than five blocks away
// from it, and a block update at its cell (mined, or replaced by a fill) means
// the next command places a fresh one.
//
// Everything goes through packets: no chat, no /give, no /item.
//
// Only 1.20.5 and later are handled here, because that is where an item's data
// moved into components. 1.21+ is the target: 1.21.5 changed how the creative
// slot sends those components (raw NBT bytes instead of described fields).

const nbt = require('prismarine-nbt');

const HOTBAR_SLOT = 36;          // first hotbar slot, window slot numbering
const HOLD_MS = 250;             // how long the given item stays in the hand
const FACE_UP = 1;
const BLOCK = 'repeating_command_block';
// All three command block types share one block entity id.
const BLOCK_ENTITY_ID = 'minecraft:command_block';
const MOVE_LIMIT = 5;            // place a new block once the bot has moved this far
const PLACE_ECHO_MS = 750;       // its own placement's block update is not damage

// 1.20.5 moved item data out of the item's own tag and into components.
function usesComponents(version) {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? ''));
    if (!match) return true;
    const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
    if (major !== 1) return major > 1;
    if (minor !== 20) return minor > 20;
    return patch >= 5;
}

// 1.21.5 stopped describing item components to the protocol: the creative slot
// takes each component's data as the NBT bytes themselves.
function usesRawComponents(version) {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? ''));
    if (!match) return true;
    const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
    if (major !== 1) return major > 1;
    if (minor !== 21) return minor > 21;
    return patch >= 5;
}

// The command block's own data: the stored command, and "always active" so it
// runs the moment the block is placed instead of waiting for redstone.
function blockEntityTag(command) {
    return nbt.comp({
        id: nbt.string(BLOCK_ENTITY_ID),
        Command: nbt.string(String(command || '').replace(/^\//, '')),
        auto: nbt.byte(1),
        TrackOutput: nbt.byte(1)
    });
}

// A command block item with the command already inside it, so the placed block
// runs it straight away. Both recognised item shapes are supported:
//  - up to 1.21.4 the slot describes the component, and takes the tag itself,
//  - 1.21.5 and later take the component's own bytes, so the tag is written as
//    network NBT (no root name) and the id is whatever the server registered.
function commandBlockItem(version, itemId, command, componentId) {
    if (!usesComponents(version)) return null;
    const tag = blockEntityTag(command);

    if (!usesRawComponents(version)) {
        return {
            itemCount: 1,
            itemId,
            addedComponentCount: 1,
            removedComponentCount: 0,
            components: [{ type: 'block_entity_data', data: tag }],
            removeComponents: []
        };
    }

    if (componentId === undefined || componentId === null) return null;
    return {
        itemCount: 1,
        itemId,
        addedComponentCount: 1,
        removedComponentCount: 0,
        components: [{
            type: componentId,
            data: nbt.proto.createPacketBuffer('anonymousNbt', tag)
        }],
        removeComponents: []
    };
}

// update_command_block carries the block's own mode, and the command has to be
// sent in the mode the block actually is.
function blockMode(block) {
    if (/chain_command_block$/.test(block)) return 0;
    if (/repeating_command_block$/.test(block)) return 1;
    return 2;
}

class FillItem {
    constructor({ bot, logger, data = null, config = {} }) {
        this.bot = bot;
        this.log = logger;
        this.data = data;
        this.block = String(config.itemBlock || BLOCK);
        this.mode = blockMode(this.block);
        this.holdMs = Number(config.holdMs ?? config.breakDelayMs) > 0
            ? Number(config.holdMs ?? config.breakDelayMs)
            : HOLD_MS;
        this.carrier = null;      // where the bot's own command block stands
        this.origin = null;       // where the bot stood when it was placed
        this.placedAt = 0;
        this.sequence = 0;
        this.clearTimer = null;
        this.broken = false;
        this.lastSendAt = 0;
    }

    // A kick right after a placement is the placement's fault. One is enough:
    // reconnecting just to be kicked again teaches nothing.
    onDisconnect() {
        if (!this.lastSendAt) return false;
        if (Date.now() - this.lastSendAt > 2000) return false;

        this.broken = true;
        this.lastSendAt = 0;
        this.log.warn(
            'the refill command block item got the bot disconnected; ' +
            'using the core blocks instead (set core.refill.item false to skip it)'
        );
        return true;
    }

    mcd() {
        if (this.data === null) {
            try {
                // eslint-disable-next-line global-require
                this.data = require('minecraft-data')(this.version());
            } catch {
                this.data = false;
            }
        }
        return this.data || null;
    }

    version() {
        return this.bot?.client?.version || this.bot?.version || null;
    }

    // The server's own registry beats any bundled data: its position is the id.
    itemId() {
        const name = this.block.replace(/^minecraft:/, '');
        const fromServer = this.bot?.registries?.item?.get?.(name);
        if (fromServer !== undefined) return fromServer;
        return this.mcd()?.itemsByName?.[name]?.id;
    }

    // The server's data-component registry is the authority on the component id:
    // the ids move between versions, and the bundled data can be older than the
    // server (a 26.1 client against a 26.2 server, for instance).
    componentId() {
        const fromServer = this.bot?.registries?.components?.get?.('block_entity_data');
        if (fromServer !== undefined) return fromServer;

        const mappings = this.mcd()?.protocol?.types?.SlotComponentType?.[1]?.mappings;
        if (!mappings) return undefined;
        const key = Object.keys(mappings).find(id => mappings[id] === 'block_entity_data');
        return key === undefined ? undefined : Number(key);
    }

    get usable() {
        if (this.broken) return false;
        if (!this.bot || typeof this.bot.write !== 'function') return false;
        const version = this.version();
        if (!usesComponents(version)) return false;
        if (this.itemId() === undefined) return false;
        if (usesRawComponents(version) && this.componentId() === undefined) return false;
        return true;
    }

    get standing() {
        return Boolean(this.carrier && !this.broken);
    }

    // Command blocks can only be placed in creative.
    get creative() {
        const mode = this.bot?.selfCare?.gamemode;
        return mode === null || mode === undefined || mode === 1;
    }

    feet() {
        const position = this.bot?.position;
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
        return {
            x: Math.floor(position.x),
            y: Math.floor(position.y),
            z: Math.floor(position.z)
        };
    }

    // The block only has to be re-placed when the bot has actually left it.
    moved(at) {
        if (!this.origin) return true;
        return Math.hypot(
            at.x - this.origin.x,
            at.y - this.origin.y,
            at.z - this.origin.z
        ) > MOVE_LIMIT;
    }

    nextSequence() {
        this.sequence = (this.sequence + 1) % 32768;
        return this.sequence;
    }

    // Runs a command through the bot's own block: it is placed if there is none
    // (or it is too far away), and edited in place otherwise. Returns the block
    // the command went into, like Core.run returns the cell it wrote.
    run(command) {
        if (!this.usable) return null;

        const at = this.feet();
        if (!at) return null;

        if (!this.carrier || this.moved(at)) return this.placeCarrier(command);
        return this.write(this.carrier, command);
    }

    // Writes the command into the block: the same packet the core uses for its
    // own blocks, so the block repeats it with `auto` on.
    write(cell, command) {
        const sent = this.bot.write('update_command_block', {
            location: cell,
            command: String(command || '').replace(/^\//, '').slice(0, 32000),
            mode: this.mode,
            flags: 0b101
        });
        return sent === false ? null : cell;
    }

    placeCarrier(command) {
        if (!this.creative) {
            this.log.warn(
                `refill items need creative mode (the bot is in gamemode ${this.bot?.selfCare?.gamemode}); ` +
                'refilling through the core instead'
            );
            this.broken = true;
            return null;
        }

        const old = this.carrier;
        this.lastSendAt = Date.now();
        if (!this.give(command)) return null;

        const placed = this.place();
        if (!placed) {
            this.clear();
            return null;
        }

        // One block at a time: the old one is only removed when it is replaced.
        if (old) this.breakAt(old);
        this.carrier = placed;
        this.origin = { ...placed };
        this.placedAt = Date.now();
        this.scheduleClear();
        return placed;
    }

    // The item goes into the hotbar slot the bot is holding: the creative slot
    // packet carries the command block and its data, so no chat is involved.
    give(command) {
        const itemId = this.itemId();
        if (itemId === undefined) return false;
        const item = commandBlockItem(this.version(), itemId, command, this.componentId());
        if (!item) return false;

        if (!this.bot.write('set_creative_slot', { slot: HOTBAR_SLOT, item })) return false;
        return this.bot.write('held_item_slot', { slotId: 0 });
    }

    // Places the item against the block the bot stands on, so the block lands at
    // the bot's feet - in the air, never inside the core.
    place() {
        const target = this.feet();
        if (!target) return null;

        const support = { x: target.x, y: target.y - 1, z: target.z };
        const sent = this.bot.write('block_place', {
            hand: 0,
            location: support,
            direction: FACE_UP,
            cursorX: 0.5,
            cursorY: 1,
            cursorZ: 0.5,
            insideBlock: false,
            worldBorderHit: false,
            sequence: this.nextSequence()
        });
        return sent ? target : null;
    }

    // Only ever this block: the core is not touched.
    breakAt(location) {
        this.bot.write('block_dig', {
            status: 0,
            location,
            face: FACE_UP,
            sequence: this.nextSequence()
        });
    }

    // A creative slot is only cleared by overwriting it with nothing.
    emptyItem() {
        return { itemCount: 0, components: [], removeComponents: [] };
    }

    clear() {
        return this.bot.write('set_creative_slot', { slot: HOTBAR_SLOT, item: this.emptyItem() })
            !== false;
    }

    scheduleClear() {
        if (this.clearTimer) clearTimeout(this.clearTimer);
        this.clearTimer = setTimeout(() => {
            this.clearTimer = null;
            this.clear();
        }, this.holdMs);
        this.clearTimer.unref?.();
    }

    // A block update at the block's own cell means it is gone: somebody mined it,
    // or a fill replaced it. Its placement's own update is not that.
    noteBlockChange(packet) {
        if (!this.carrier) return false;
        if (Date.now() - this.placedAt < PLACE_ECHO_MS) return false;

        const location = packet?.location;
        if (!location) return false;
        if (location.x !== this.carrier.x || location.y !== this.carrier.y || location.z !== this.carrier.z) {
            return false;
        }

        this.carrier = null;
        this.origin = null;
        return true;
    }

    destroy() {
        if (this.clearTimer) clearTimeout(this.clearTimer);
        this.clearTimer = null;
        this.carrier = null;
        this.origin = null;
    }
}

module.exports = { FillItem, commandBlockItem, blockMode, HOTBAR_SLOT, BLOCK, MOVE_LIMIT };
