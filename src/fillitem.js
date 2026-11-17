'use strict';

// The bot's own command blocks: a small mini core that stands beside it.
//
// They are placed from a creative slot packet that holds nothing but a command
// block, and then every command is written into one of them with
// `update_command_block`, exactly how the main core's blocks are written. The
// blocks are repeating command blocks with `auto`, so what they hold keeps
// running on its own, and a command written into one runs every tick.
//
// The mini core never holds a command meant for the main core. What is written
// into it is always a block write - `setblock <cell> repeating_command_block{
// Command:...,auto:1b}` - so the command ends up in a real core block, with
// `auto` set, and that block is the one that runs it.
//
// The mini core is a cube `itemSize` blocks on a side (3 by default, so 27
// blocks), standing on the ground beside the bot and centred on it along z: no
// cell of it is ever inside the player, where a block cannot be placed. The
// bottom layer goes in first, so every layer above has the one under it to be
// placed against. Commands are spread over the cube in turn: a block that is
// still running the command before is not overwritten by the next one, which is
// what makes back-to-back commands safe.
//
// A block is not kept once its command has run: it is dug up a moment later, so
// the cube never leaves a command block behind in the world and the next command
// places a fresh one instead of writing over a block that is still working.
//
// Nothing but the item id goes into the slot packet. A `block_entity_data`
// component on it is not portable: Paper 26.1.2 fails to decode
// `set_creative_mode_slot` when one is present and closes the connection without
// a kick message, and the block entity type ids differ between versions and
// servers. The command and "always active" are set afterwards over the command
// block packet instead, which every version and every server understands.
//
// Which cell accepted a block is learned from the server's own block update; a
// cell that answered with air is not tried again. The cube is placed again when
// the bot has moved more than five blocks away from it, and a block update at one
// of its cells (mined, or replaced by a fill) means the next command places a
// fresh one.
//
// Everything goes through packets: no chat, no /give, no /item.

const HOTBAR_SLOT = 36;          // first hotbar slot, window slot numbering
const HOLD_MS = 250;             // how long the given item stays in the hand
const FACE_UP = 1;
const BLOCK = 'repeating_command_block';
const SIZE = 3;                  // the mini core is SIZE by SIZE by SIZE blocks
const MAX_SIZE = 8;
const MOVE_LIMIT = 5;            // place a new cube once the bot has moved this far
const PLACE_ECHO_MS = 2000;      // the placement and the command edit arrive in here
const SETTLE_MS = 800;           // how long a placement has to be answered
const STEP_MS = 120;             // gap between the commands of one command
const AFTER_RUN_MS = 200;        // how long a written command gets before its block goes
const PENDING_MS = 2000;         // a placement echo older than this is not ours
const AIR = 0;                   // air's block state number in every version

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
        // Cells the cube should stay out of when a side of the bot allows it: the
        // core's own area, whose fill would replace it on every refill.
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
        // The blocks are not kept: once the command written into one has had the
        // time to run, the block is broken and the cell is free again.
        this.afterRunMs = Number(config.afterRunMs) > 0 ? Number(config.afterRunMs) : AFTER_RUN_MS;
        this.breakTimers = new Set();
        // The cube's edge in blocks: 3 means 3x3x3, 27 blocks of its own.
        const size = Math.floor(Number(config.itemSize));
        this.size = Number.isFinite(size) ? Math.min(Math.max(size, 1), MAX_SIZE) : SIZE;
        // The blocks that are standing, by the cube cell they were placed for.
        this.slots = new Map();
        this.turn = 0;            // which cell of the cube the next command goes to
        this.origin = null;       // where the bot stood when the cube was placed
        this.placedAt = 0;
        this.pending = null;      // a placement waiting for the server's answer
        this.blocked = new Set(); // cells that refused a block
        this.sequence = 0;
        this.clearTimer = null;
        this.broken = false;
        this.lastSendAt = 0;
    }

    // Any block of the cube is enough: the mini core is up.
    get standing() {
        return this.slots.size > 0;
    }

    // Cells the mini core currently stands on; the core keeps them out of refills.
    cells() {
        return [...this.slots.values()].map(slot => ({ ...slot.cell }));
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

    // The cube only has to be re-placed when the bot has actually left it.
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

    // The cells of the cube, bottom layer first so every layer has the one under
    // it to be placed against.
    cube(start) {
        const cells = [];
        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                for (let z = 0; z < this.size; z++) {
                    cells.push({ x: start.x + x, y: start.y + y, z: start.z + z });
                }
            }
        }
        return cells;
    }

    // Where the cube starts: beside the bot, never on top of it, centred on it
    // along z. A side that keeps the whole cube out of the core's area is
    // preferred when there is one.
    anchor(at = this.feet()) {
        if (!at) return null;
        const mid = Math.floor((this.size - 1) / 2);
        const starts = [
            { x: at.x + 1, y: at.y, z: at.z - mid },
            { x: at.x - this.size, y: at.y, z: at.z - mid },
            { x: at.x - mid, y: at.y, z: at.z + 1 },
            { x: at.x - mid, y: at.y, z: at.z - this.size }
        ];
        if (!this.avoid) return starts[0];
        return starts.find(start => this.cube(start).every(cell => !this.avoid(cell))) || starts[0];
    }

    // Writes commands into the mini core, one block of the cube at a time, taken
    // in turn. A cell that is not standing yet is placed, and the commands follow
    // it as soon as the server says where it landed. Returns the cell the commands
    // were written to (the placement's guessed cell until it settles).
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

        const start = this.anchor(at);
        if (!start) return null;
        const cells = this.cube(start);

        for (let step = 0; step < cells.length; step++) {
            const index = (this.turn + step) % cells.length;
            const cell = cells[index];
            const key = cellKey(cell);
            if (this.blocked.has(key)) continue;

            this.turn = (index + 1) % cells.length;
            const slot = this.slots.get(key);
            if (slot) {
                if (!this.writeAll(slot.cell, list, key)) return null;
                return slot.cell;
            }
            return this.placeSlot(key, cell, list);
        }

        // Every cell of the cube refused a block: forget that and try again from
        // where the turn stands.
        this.blocked.clear();
        const cell = cells[this.turn];
        return this.placeSlot(cellKey(cell), cell, list);
    }

    // Writes the commands of one operation into the block, one step at a time, and
    // digs the block up once the last of them has run: the cube only ever holds a
    // command for as long as that command needs.
    writeAll(cell, commands, key = null) {
        const list = [...commands];
        if (!list.length) return true;
        if (!this.write(cell, list.shift())) return false;
        list.forEach((command, index) => {
            const timer = setTimeout(() => this.write(cell, command), this.stepMs * (index + 1));
            timer.unref?.();
        });
        if (key) this.scheduleBreak(cell, key, this.stepMs * list.length + this.afterRunMs);
        return true;
    }

    // The command has run: the block goes, and its cell is free for the next one.
    scheduleBreak(cell, key, after) {
        const timer = setTimeout(() => {
            this.breakTimers.delete(timer);
            this.slots.delete(key);
            this.breakAt(cell);
        }, Math.max(Number(after) || 0, 0));
        timer.unref?.();
        this.breakTimers.add(timer);
    }

    // Writes one command into the block: the same packet the core uses for its
    // own blocks, with `auto` so the block runs it without redstone.
    write(cell, command) {
        const sent = this.bot.write('update_command_block', {
            location: cell,
            command: String(command || '').replace(/^\//, '').slice(0, 32000),
            mode: this.mode,
            flags: 0b101
        });
        return sent !== false;
    }

    // The bot moved away: the cube is too far to be worth keeping, so it is dug up
    // and placed again where the bot stands now.
    reposition() {
        for (const timer of this.breakTimers) clearTimeout(timer);
        this.breakTimers.clear();
        for (const slot of this.slots.values()) this.breakAt(slot.cell);
        this.slots.clear();
        this.blocked.clear();
        this.pending = null;
        this.turn = 0;
        this.origin = this.feet();
    }

    placeSlot(key, cell, commands) {
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

        if (!this.place(cell)) {
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
            key,
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
    // really there, or give up on this cell when nothing was placed.
    settle(placement) {
        if (this.pending !== placement) return;
        this.pending = null;
        if (placement.timer) clearTimeout(placement.timer);
        placement.timer = null;

        if (!placement.landed) {
            // Nothing was placed, or the server never said where it went: the
            // commands are lost either way, so the cell is not used again and the
            // next one of the cube is tried.
            this.blocked.add(placement.key);
            this.log.debug(`nothing could be placed at ${placement.cell.x} ${placement.cell.y} ${placement.cell.z}; trying another cell`);
            return;
        }

        const at = { ...placement.landed };
        this.slots.set(placement.key, {
            cell: at,
            state: placement.state,
            placedAt: Date.now()
        });
        this.writeAll(at, placement.queue, placement.key);
    }

    // The item goes into the hotbar slot the bot is holding, by packet only.
    give() {
        const itemId = this.itemId();
        if (itemId === undefined) return false;

        const item = commandBlockItem(itemId);
        if (this.bot.write('set_creative_slot', { slot: HOTBAR_SLOT, item }) === false) return false;
        return this.bot.write('held_item_slot', { slotId: 0 }) !== false;
    }

    // Places the item against the top of the block under that cell: the ground,
    // or the block of the layer below, so the cube grows upwards.
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

    // Only ever the cube's own blocks: the core is not touched.
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

    // A block update at one of the cube's own cells is the server's answer about
    // it.
    //
    // While a placement is waiting, a non-air update at the cell that was clicked
    // or at the cell above it says where the block really is, and the commands are
    // written there. Air at the target alone means the cell refused, and another
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

        for (const [key, slot] of this.slots) {
            if (!sameCell(location, slot.cell)) continue;

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

            this.slots.delete(key);
            return true;
        }

        return false;
    }

    destroy() {
        if (this.clearTimer) clearTimeout(this.clearTimer);
        this.clearTimer = null;
        for (const timer of this.breakTimers) clearTimeout(timer);
        this.breakTimers.clear();
        this.slots.clear();
        this.origin = null;
        this.pending = null;
    }
}

module.exports = { FillItem, commandBlockItem, blockMode, HOTBAR_SLOT, BLOCK, SIZE, MOVE_LIMIT };
