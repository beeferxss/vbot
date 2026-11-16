'use strict';

// Refilling by giving the bot a command block *item* and placing it, instead of
// writing into the core: the block is put in the air at the bot's feet, the fill
// is written into that one block, and it is broken again a moment later. An
// impulse block would have to be triggered, so the item is a repeating block,
// which runs whatever it holds every tick until it is broken.
//
// Everything goes through packets: no /give, no chat.

const nbt = require('prismarine-nbt');

const HOTBAR_SLOT = 36;          // first hotbar slot, packet slot numbering
const BREAK_DELAY_MS = 250;
const FACE_UP = 1;
const BLOCK = 'repeating_command_block';

// 1.20.5 stopped sending an absent item as "present: false".
function usesComponents(version) {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? ''));
    if (!match) return true;
    const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
    if (major !== 1) return major > 1;
    if (minor !== 20) return minor > 20;
    return patch >= 5;
}

// A plain block item: no components, so nothing has to be translated between
// versions and there is no id in the packet to get wrong.
function plainItem(version, itemId) {
    if (usesComponents(version)) {
        return {
            itemCount: 1,
            itemId,
            addedComponentCount: 0,
            removedComponentCount: 0,
            components: [],
            removeComponents: []
        };
    }
    return { present: true, itemCount: 1, itemId };
}

class FillItem {
    constructor({ bot, logger, data = null, config = {} }) {
        this.bot = bot;
        this.log = logger;
        this.data = data;
        this.breakDelayMs = Number(config.breakDelayMs) > 0 ? Number(config.breakDelayMs) : BREAK_DELAY_MS;
        this.block = String(config.itemBlock || BLOCK);
        this.sequence = 0;
        this.timer = null;
        this.placed = null;
        // The server sends the slot back when it accepts a creative slot, so an
        // item that never comes back was never given.
        this.confirmed = false;
        this.misses = 0;
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
        const fromServer = this.bot?.registries?.item?.get?.(this.block);
        if (fromServer !== undefined) return fromServer;
        return this.mcd()?.itemsByName?.[this.block]?.id;
    }

    get usable() {
        if (this.broken) return false;
        if (!this.bot || typeof this.bot.write !== 'function') return false;
        return this.itemId() !== undefined;
    }

    // Creative is the only mode where a creative slot is accepted at all.
    get creative() {
        const mode = this.bot?.selfCare?.gamemode;
        return mode === null || mode === undefined || mode === 1;
    }

    nextSequence() {
        this.sequence = (this.sequence + 1) % 32768;
        return this.sequence;
    }

    noteSlot(packet) {
        if (Number(packet?.slot) !== HOTBAR_SLOT) return;
        const item = packet?.item;
        if (item && (item.itemCount ?? 0) > 0) this.confirmed = true;
    }

    // Two packets: the item into the hotbar, and the hotbar slot selected.
    give() {
        const itemId = this.itemId();
        if (itemId === undefined) return false;
        if (!this.bot.write('set_creative_slot', {
            slot: HOTBAR_SLOT,
            item: plainItem(this.version(), itemId)
        })) return false;
        return this.bot.write('held_item_slot', { slotId: 0 });
    }

    // Places the item against the block the bot stands on, so the block lands at
    // the bot's feet - in the air, never inside the core.
    place() {
        const position = this.bot.position;
        if (!position) return null;

        const target = {
            x: Math.floor(position.x),
            y: Math.floor(position.y),
            z: Math.floor(position.z)
        };
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

    // The block is repeating, so the command runs on the next tick and keeps
    // running until the block is gone.
    writeCommand(location, command, mode) {
        return this.bot.write('update_command_block', {
            location,
            command,
            mode,
            flags: 0b101
        });
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
        if (usesComponents(this.version())) {
            return { itemCount: 0, components: [], removeComponents: [] };
        }
        return { present: false };
    }

    clear() {
        return this.bot.write('set_creative_slot', { slot: HOTBAR_SLOT, item: this.emptyItem() });
    }

    // Give, place, fill that block, and break it after a moment. One cycle at a
    // time: the next placement would land in the block still standing.
    run(command, mode) {
        if (!this.usable) return false;
        if (this.timer) return false;

        if (!this.creative) {
            this.log.warn(
                `refill items need creative mode (the bot is in gamemode ${this.bot?.selfCare?.gamemode}); ` +
                'refilling through the core instead'
            );
            this.broken = true;
            return false;
        }

        this.confirmed = false;
        this.lastSendAt = Date.now();
        if (!this.give()) return false;

        const placed = this.place();
        if (!placed) {
            this.clear();
            return false;
        }

        this.writeCommand(placed, String(command || '').replace(/^\//, ''), mode);
        this.placed = placed;
        this.timer = setTimeout(() => {
            this.timer = null;
            const location = this.placed;
            this.placed = null;
            this.breakAt(location);
            this.clear();
            this.checkGiven();
        }, this.breakDelayMs);
        this.timer.unref?.();

        return true;
    }

    // The slot never came back: this server will not take the item, so stop
    // asking and leave refills to the core.
    checkGiven() {
        if (this.confirmed) {
            this.misses = 0;
            return;
        }

        this.misses += 1;
        this.log.warn(
            `the command block item did not arrive (version ${this.version() ?? 'unknown'}, ` +
            `attempt ${this.misses}); is the bot opped and in creative?`
        );
        if (this.misses >= 2) this.broken = true;
    }

    destroy() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.placed = null;
    }
}

module.exports = { FillItem, plainItem, usesComponents, HOTBAR_SLOT, nbt };
