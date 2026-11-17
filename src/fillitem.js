'use strict';

// The bot's own command blocks: a small mini core that stands beside it.
//
// They are placed from a creative slot packet that holds nothing but a command
// block, and then every command is written into one of them with
// `update_command_block`, exactly how the main core's blocks are written. The
// blocks are normal (impulse) command blocks: a command runs once, there is no
// repeating block left running in the world.
//
// The mini core never holds a command meant for the main core. What is written
// into it is always a block write - `setblock <cell> command_block{Command:...,
// auto:1b}` - so the command ends up in a real core block, with `auto` set, and
// that block is the one that runs it.
//
// Four blocks are placed, one on each side of the bot, and commands are spread
// over them in turn: a command that is still being worked on in one block is not
// overwritten by the next one, which is what makes back-to-back commands safe.
//
// Nothing but the item id goes into the slot packet. A `block_entity_data`
// component on it is not portable: Paper 26.1.2 fails to decode
// `set_creative_mode_slot` when one is present and closes the connection without
// a kick message, and the block entity type ids differ between versions and
// servers. The command and "always active" are set afterwards over the command
// block packet instead, which every version and every server understands.
//
// The blocks are placed on the ground next to the bot, never at its feet: a solid
// block cannot be placed inside the player, and the server silently ignores the
// attempt. Which side accepted a block is learned from the server's own block
// update; a side that answered with air is not tried again.
//
// The blocks are placed again when the bot has moved more than five blocks away
// from them, and a block update at one of their cells (mined, or replaced by a
// fill) means the next command places a fresh one.
//
// Everything goes through packets: no chat, no /give, no /item.

const HOTBAR_SLOT = 36;          // first hotbar slot, window slot numbering
const HOLD_MS = 250;             // how long the given item stays in the hand
const FACE_UP = 1;
const BLOCK = 'command_block';
const MOVE_LIMIT = 5;            // place new blocks once the bot has moved this far
const PLACE_ECHO_MS = 2000;      // the placement and the command edit arrive in here
const SETTLE_MS = 800;           // how long a placement has to be answered
const STEP_MS = 120;             // gap between the commands of one command
const PENDING_MS = 2000;         // a placement echo older than this is not ours
const AIR = 0;                   // air's block state number in every version
const SIDES = 4;

// 1.20.5 is where an item in the slot packet gained the added/removed component
// counts; before that the packet carries a plain item tag instead.
function usesComponents(version) {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? ''));
    if (!match) return true;
    const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
    if (major !== 1) return major > 1;
    if (minor !== 20) return minor > 20;
    return patch >= 5;
}

// A command block with no components at all. The command, `auto` and the mode
// are written into the placed block over the command block packet.
function commandBlockItem(itemId) {
    return {
        itemCount: 1,
        itemId,
        addedComponentCount: 0,
        removedComponentCount: 0,
        components: [],
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

function cellKey(cell) {
    return `${Math.floor(cell.x)}:${Math.floor(cell.y)}:${Math.floor(cell.z)}`;
}

function sameCell(a, b) {
    if (!a || !b) return false;
    return Math.floor(a.x) === Math.floor(b.x)
        && Math.floor(a.y) === Math.floor(b.y)
        && Math.floor(a.z) === Math.floor(b.z);
}

// A block change packet carries the new block state as a number on every
// version this handles; air is 0.
function blockState(packet) {
    const state = packet?.type ?? packet?.state ?? packet?.blockId;
    if (state === 'minecraft:air' || state === 'air') return AIR;
    const number = Number(state);
    return Number.isFinite(number) ? number : null;
}

class FillItem {
    constructor({ bot, logger, data = null, config = {}, avoid = null }) {
        this.bot = bot;
        this.log = logger;
        this.data = data;
        // Cells these blocks should stay out of when another side will do: the
        // core's own area, whose fill would replace them on every refill.
        this.avoid = typeof avoid === 'function' ? avoid : null;
        this.block = String(config.itemBlock || BLOCK);
        this.mode = blockMode(this.block);
        this.holdMs = Number(config.holdMs ?? config.breakDelayMs) > 0
            ? Number(config.holdMs ?? config.breakDelayMs)
            : HOLD_MS;
        // Commands that belong together (clear the cell, then create the block)
        // are written a tick apart, so the second one always sees the first one's
        // result instead of landing in the same moment.
        this.stepMs = Number(config.stepMs) > 0 ? Number(config.stepMs) : STEP_MS;
        // One block per side, so consecutive commands do not overwrite a block
        // that is still running the command before.
        this.slots = new Array(SIDES).fill(null);
        this.turn = 0;            // which side the next command goes to
        this.origin = null;       // where the bot stood when the set was placed
        this.placedAt = 0;
        this.pending = null;      // a placement waiting for the server's answer
        this.blocked = new Set(); // cells that refused a block
        this.side = 0;
        this.sequence = 0;
        this.clearTimer = null;
        this.broken = false;
        this.lastSendAt = 0;
    }

    // Any block of the set is enough: the mini core is up.
    get standing() {
        return this.slots.some(slot => Boolean(slot));
    }

    // Cells the mini core currently stands on; the core keeps them out of refills.
    cells() {
        return this.slots.filter(Boolean).map(slot => ({ ...slot.cell }));
    }

    // A kick right after the slot packet is that packet's fault. One is enough:
    // reconnecting just to be kicked again teaches nothing.
    onDisconnect() {
        if (!this.lastSendAt) return false;
        if (Date.now() - this.lastSendAt > 2000) return false;

        this.broken = true;
        this.lastSendAt = 0;
        this.pending = null;
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

    // A block update only says the state number. The bot's own block is a command
    // block on every version, so a state that names anything else (the ground it
    // was placed against, most often) is not an echo of the placement.
    isOwnState(state) {
        if (state === null || state === undefined) return false;
        if (state === AIR) return false;
        const byState = this.mcd()?.blocksByStateId?.[state];
        if (!byState) return true; // no palette for this version: trust the number
        return String(byState.name || '').includes('command_block');
    }

    // The server's own registry beats any bundled data: its position is the id.
    itemId() {
        const name = this.block.replace(/^minecraft:/, '');
        const fromServer = this.bot?.registries?.item?.get?.(name);
        if (fromServer !== undefined) return fromServer;
        return this.mcd()?.itemsByName?.[name]?.id;
    }

    get usable() {
        if (this.broken) return false;
        if (!this.bot || typeof this.bot.write !== 'function') return false;
        if (!usesComponents(this.version())) return false;
        return this.itemId() !== undefined;
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

    // The blocks only have to be re-placed when the bot has actually left them.
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

    // Writes commands into the mini core, one block at a time, taken in turn.
    // A block that is not standing yet is placed, and the commands follow it as
    // soon as the server says where it landed. Returns the cell the commands were
    // written to (the placement's guessed cell until it settles).
    run(...commands) {
        const list = commands
            .flat()
            .map(command => String(command || '').trim())
            .filter(Boolean);
        if (!list.length) return null;
        if (!this.usable) return null;

        const at = this.feet();
        if (!at) return null;

        if (this.moved(at)) this.reposition();
        if (!this.origin) this.origin = { ...at };

        // While a placement is still being confirmed the block is not known yet;
        // the commands wait with it instead of being written into air.
        if (this.pending) {
            this.pending.queue.push(...list);
            return this.pending.cell;
        }

        const index = this.turn % SIDES;
        this.turn = (this.turn + 1) % SIDES;

        const slot = this.slots[index];
        if (slot) {
            if (!this.writeAll(slot.cell, list)) return null;
            return slot.cell;
        }
        return this.placeSlot(index, list);
    }

    // Writes the commands of one operation into the block, one step at a time.
    writeAll(cell, commands) {
        const list = [...commands];
        if (!list.length) return true;
        if (!this.write(cell, list.shift())) return false;
        list.forEach((command, index) => {
            const timer = setTimeout(() => this.write(cell, command), this.stepMs * (index + 1));
            timer.unref?.();
        });
        return true;
    }

    // Writes one command into the block: the same packet the core uses for its
    // own blocks. The block is normal (impulse), so a command runs once instead
    // of every tick.
    write(cell, command) {
        const sent = this.bot.write('update_command_block', {
            location: cell,
            command: String(command || '').replace(/^\//, '').slice(0, 32000),
            mode: this.mode,
            flags: 0b101
        });
        return sent !== false;
    }

    // The bot moved away: the blocks are too far to be worth keeping, so they are
    // removed and a new set is placed where it stands now.
    reposition() {
        for (const slot of this.slots) {
            if (slot) this.breakAt(slot.cell);
        }
        this.slots = new Array(SIDES).fill(null);
        this.blocked.clear();
        this.pending = null;
        this.origin = this.feet();
    }

    placeSlot(index, commands) {
        if (!this.creative) {
            this.log.warn(
                `refill items need creative mode (the bot is in gamemode ${this.bot?.selfCare?.gamemode}); ` +
                'refilling through the core instead'
            );
            this.broken = true;
            return null;
        }

        this.lastSendAt = Date.now();
        if (!this.give()) return null;

        const cell = this.spot(index);
        if (!cell || !this.place(cell)) {
            this.clear();
            return null;
        }

        this.origin = this.feet();
        this.placedAt = Date.now();
        this.scheduleClear();

        // Where the block lands is the server's answer, not the client's: a
        // server that reads the packet as "the cell that was clicked" puts it in
        // the ground under the target instead of above it, and a command written
        // to the guessed cell lands in air and is lost. The update that arrives
        // next says which cell it is; the commands follow there.
        this.pending = {
            index,
            cell: { ...cell },
            support: { x: cell.x, y: cell.y - 1, z: cell.z },
            at: Date.now(),
            queue: [...commands],
            landed: null,
            state: null,
            refused: false,
            timer: null
        };
        const placement = this.pending;
        placement.timer = setTimeout(() => this.settle(placement), SETTLE_MS);
        placement.timer.unref?.();
        return cell;
    }

    // The placement is over: write the queued commands into the block that is
    // really there, or give up on this side when nothing was placed.
    settle(placement) {
        if (this.pending !== placement) return;
        this.pending = null;
        if (placement.timer) clearTimeout(placement.timer);
        placement.timer = null;

        if (!placement.landed) {
            // Nothing was placed, or the server never said where it went: the
            // commands are lost either way, so the cell is not used again and the
            // next one tries another side.
            this.blocked.add(cellKey(placement.cell));
            this.side = (placement.index + 1) % SIDES;
            this.log.debug(`nothing could be placed at ${placement.cell.x} ${placement.cell.y} ${placement.cell.z}; trying another side`);
            return;
        }

        const at = { ...placement.landed };
        this.slots[placement.index] = {
            cell: at,
            state: placement.state,
            placedAt: Date.now()
        };
        this.writeAll(at, placement.queue);
    }

    // The item goes into the hotbar slot the bot is holding, by packet only.
    give() {
        const itemId = this.itemId();
        if (itemId === undefined) return false;

        const item = commandBlockItem(itemId);
        if (this.bot.write('set_creative_slot', { slot: HOTBAR_SLOT, item }) === false) return false;
        return this.bot.write('held_item_slot', { slotId: 0 }) !== false;
    }

    // The cell for one block of the set: the ground beside the bot, never the
    // block it is standing in. Sides that answered with air are skipped, and a
    // side outside the core's area is preferred so a refill does not replace it.
    spot(index) {
        const at = this.feet();
        if (!at) return null;

        const spots = [
            { x: at.x + 1, y: at.y, z: at.z },
            { x: at.x, y: at.y, z: at.z + 1 },
            { x: at.x - 1, y: at.y, z: at.z },
            { x: at.x, y: at.y, z: at.z - 1 }
        ];
        const taken = new Set(this.cells().map(cellKey));
        const open = [];
        for (let step = 0; step < SIDES; step++) {
            const side = (index + step) % SIDES;
            const cell = spots[side];
            if (taken.has(cellKey(cell)) || this.blocked.has(cellKey(cell))) continue;
            open.push(cell);
        }
        if (!open.length) {
            this.blocked.clear();
            return spots[index % SIDES];
        }

        const outside = open.find(cell => !this.avoid || !this.avoid(cell));
        return outside || open[0];
    }

    // Places the item against the top of the block under that cell, so the block
    // lands in the air beside the bot.
    place(target) {
        const sent = this.bot.write('block_place', {
            hand: 0,
            location: { x: target.x, y: target.y - 1, z: target.z },
            direction: FACE_UP,
            cursorX: 0.5,
            cursorY: 0.5,
            cursorZ: 0.5,
            insideBlock: false,
            worldBorderHit: false,
            sequence: this.nextSequence()
        });
        return sent !== false;
    }

    // Only ever the bot's own blocks: the core is not touched.
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

    // A block update at one of the set's own cells is the server's answer about
    // it.
    //
    // While a placement is waiting, a non-air update at the cell that was clicked
    // or at the cell above it says where the block really is, and the commands are
    // written there. Air at the target alone means the side refused, and another
    // one is tried next time.
    //
    // Later, a block that turns to air - mined, or replaced by a fill - is gone,
    // and the next command places a fresh one.
    noteBlockChange(packet) {
        const location = packet?.location;
        if (!location) return false;

        const state = blockState(packet);

        if (this.pending && Date.now() - this.pending.at < SETTLE_MS + PENDING_MS) {
            const placement = this.pending;
            if (this.isOwnState(state) && (sameCell(location, placement.cell) || sameCell(location, placement.support))) {
                placement.landed = { x: location.x, y: location.y, z: location.z };
                placement.state = state;
                this.settle(placement);
                return false;
            }
            if (state === AIR && sameCell(location, placement.cell)) placement.refused = true;
        }

        for (let index = 0; index < SIDES; index++) {
            const slot = this.slots[index];
            if (!slot || !sameCell(location, slot.cell)) continue;

            // The command edit changes the block's state too, and it can arrive a
            // little after the placement.
            if (Date.now() - slot.placedAt < PLACE_ECHO_MS) {
                if (state !== AIR) slot.state = state;
                return false;
            }

            if (state !== AIR && (slot.state === null || state === slot.state)) {
                slot.state = state;
                return false;
            }

            this.slots[index] = null;
            return true;
        }

        return false;
    }

    destroy() {
        if (this.clearTimer) clearTimeout(this.clearTimer);
        this.clearTimer = null;
        this.slots = new Array(SIDES).fill(null);
        this.origin = null;
        this.pending = null;
    }
}

module.exports = { FillItem, commandBlockItem, blockMode, HOTBAR_SLOT, BLOCK, MOVE_LIMIT };
