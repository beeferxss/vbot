'use strict';

// The bot's own command blocks: a small mini core of its own, around it.
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
// The mini core is `itemCount` blocks (27 by default) standing around the bot on
// every side of it: they are taken ring by ring outwards from its feet, instead
// of piling up in one square beside it, and none of them is ever in the cells
// the bot stands in, where a block cannot be placed. Each layer goes in before
// the one above it, so every block has the one under it to be placed against.
// Commands are spread over them in turn: a block that is still running the
// command before is not overwritten by the next one, which is what makes
// back-to-back commands safe.
//
// A block is not kept once its command has run: it is dug up a moment later, so
// the mini core never leaves a command block behind in the world. A block that
// is asked for again before that moment stays, which is what makes a burst (a
// punishment loop, a scan) as fast as the main core: while commands keep coming,
// each one is a single write into a block that is already there, and the digging
// only starts once nothing has used the block for a moment.
//
// Commands are spread over the blocks in parallel rather than queued behind one
// block: while one cell is still being placed or is running what was written into
// it, the next command takes the next cell, so a burst is not one block wide.
//
// Nothing but the item id goes into the slot packet. A `block_entity_data`
// component on it is not portable: Paper 26.1.2 fails to decode
// `set_creative_mode_slot` when one is present and closes the connection without
// a kick message, and the block entity type ids differ between versions and
// servers. The command and "always active" are set afterwards over the command
// block packet instead, which every version and every server understands.
//
// Which cell accepted a block is learned from the server's own block update; a
// cell that answered with air is not tried again. The blocks are placed again
// when the bot has moved more than five blocks away from them, and a block update
// at one of their cells (mined, or replaced by a fill) means the next command
// places a fresh one.
//
// Everything goes through packets: no chat, no /give, no /item.

const HOTBAR_SLOT = 36;          // first hotbar slot, window slot numbering
const HOLD_MS = 250;             // how long the given item stays in the hand
const FACE_UP = 1;
const BLOCK = 'repeating_command_block';
const COUNT = 27;                // how many of its own blocks the mini core has
const MAX_COUNT = 96;
const RADIUS = 3;                // they stand up to this far out from the bot
const LAYERS = 4;                // and up to this many blocks above its feet
const MOVE_LIMIT = 5;            // place a new set once the bot has moved this far
const PLACE_ECHO_MS = 2000;      // the placement and the command edit arrive in here
const SETTLE_MS = 800;           // how long a placement has to be answered
const STEP_MS = 120;             // gap between the commands of one command
const AFTER_RUN_MS = 200;        // how long a written command gets before its block goes
const IDLE_BLOCK_MS = 2000;      // a block placed ahead of use goes if nothing uses it
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
        // Cells the mini core should stay out of when there is room: the
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
        // How many blocks of its own the mini core has, spread around the bot.
        const count = Math.floor(Number(config.itemCount));
        this.count = Number.isFinite(count) ? Math.min(Math.max(count, 1), MAX_COUNT) : COUNT;
        // The blocks that are standing, by the cell they were placed for.
        this.slots = new Map();
        this.turn = 0;            // which cell the next command goes to
        // The cells around a spot do not change while the bot stands there, and a
        // burst asks for them on every command: they are worked out once.
        this.ringKey = null;
        this.ringCells = [];
        this.origin = null;       // where the bot stood when the blocks went down
        this.placedAt = 0;
        // Placements waiting for the server's answer, by cell. Several can be in
        // the air at once, one per cell, so a burst is not held up by the first.
        this.pending = new Map();
        this.blocked = new Set(); // cells that refused a block
        this.sequence = 0;
        this.clearTimer = null;
        this.broken = false;
        this.lastSendAt = 0;
    }

    // Any block of the mini core is enough: it is up.
    get standing() {
        return this.slots.size > 0;
    }

    // How many blocks of the mini core are still being placed.
    get pendingCount() {
        return this.pending.size;
    }

    // Blocks that are free right now: placed, and not still running a command.
    get ready() {
        const now = Date.now();
        return [...this.slots.values()].filter(slot => !(slot.busyUntil > now)).length;
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
        this.pending.clear();
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

    // The cells around the bot, in the order they are taken: ring by ring
    // outwards, a layer at a time, every layer's cells on every side of it.
    ring(at) {
        const key = `${at.x}:${at.y}:${at.z}`;
        if (this.ringKey === key) return this.ringCells;
        const cells = [];
        for (let layer = 0; layer < LAYERS; layer++) {
            for (let radius = 1; radius <= RADIUS; radius++) {
                const ring = [];
                for (let dx = -radius; dx <= radius; dx++) {
                    for (let dz = -radius; dz <= radius; dz++) {
                        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
                        ring.push({ x: at.x + dx, y: at.y + layer, z: at.z + dz, dx, dz });
                    }
                }
                ring.sort((a, b) => Math.atan2(a.dz, a.dx) - Math.atan2(b.dz, b.dx)
                    || a.dx - b.dx
                    || a.dz - b.dz);
                // Taken from opposite sides in turn, so a count that stops in the
                // middle of a ring still has blocks on every side of the bot
                // instead of a wedge on one of them.
                const half = Math.ceil(ring.length / 2);
                for (let i = 0; i < half; i++) {
                    cells.push({ x: ring[i].x, y: ring[i].y, z: ring[i].z });
                    const across = ring[i + half];
                    if (across) cells.push({ x: across.x, y: across.y, z: across.z });
                }
            }
        }

        this.ringKey = key;
        this.ringCells = cells;
        return cells;
    }

    // The cells of the mini core: `count` of them, spread around the bot on
    // every side instead of in one square beside it, and never in the cells it
    // stands in. A cell above another always has the one below it, and takes the
    // block placed there.
    spots(at = this.feet()) {
        if (!at) return [];
        const wanted = this.ring(at).slice(0, this.count);
        if (!this.avoid) return wanted;

        // Cells the core's own fill would replace are taken last, but never
        // dropped: a bot standing inside its own core has nowhere else to place.
        const clear = wanted.filter(cell => !this.avoid(cell));
        if (clear.length === wanted.length) return wanted;
        return [...clear, ...wanted.filter(cell => this.avoid(cell))];
    }

    // Puts the whole mini core down at once, rather than a block per command: one
    // give of the item, then a placement for every cell that has none, so the
    // blocks are standing before the commands that need them arrive. A cell that
    // refused a block is left alone; the next one around the bot is used instead.
    grow(at = this.feet()) {
        if (!this.usable || !this.creative || !at) return 0;
        if (this.moved(at)) this.reposition();
        if (!this.origin) this.origin = { ...at };

        const fresh = this.spots(at).filter(cell => {
            const key = cellKey(cell);
            return !this.blocked.has(key) && !this.pending.has(key) && !this.slots.has(key);
        });
        if (!fresh.length) return 0;
        if (!this.give()) return 0;

        let placed = 0;
        for (const cell of fresh) {
            if (!this.placeSlot(cellKey(cell), cell, [], true)) break;
            placed += 1;
        }
        return placed;
    }

    // Writes commands into the mini core, one of its blocks at a time, taken in
    // turn. A cell that is not standing yet is placed, and the commands follow it
    // as soon as the server says where it landed. Returns the cell the commands
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

        // The blocks that are not standing yet go down in one go: waiting for a
        // command per block leaves the first burst writing into a handful of them.
        if (this.slots.size + this.pending.size < this.count) this.grow(at);

        const cells = this.spots(at);
        if (!cells.length) return null;
        const now = Date.now();

        for (let step = 0; step < cells.length; step++) {
            const index = (this.turn + step) % cells.length;
            const cell = cells[index];
            const key = cellKey(cell);
            if (this.blocked.has(key)) continue;
            // A cell that is still being placed, or whose block is still running
            // what was written into it, is passed over: the next command goes to
            // the next cell instead of waiting for that one.
            if (this.pending.has(key)) continue;
            const slot = this.slots.get(key);
            if (slot && slot.busyUntil > now) continue;

            this.turn = (index + 1) % cells.length;
            if (slot) {
                if (!this.writeAll(slot.cell, list, slot)) return null;
                return slot.cell;
            }
            return this.placeSlot(key, cell, list);
        }

        // Every cell is busy, being placed, or refused a block. A placement that
        // has not answered yet takes the command into its queue, the one with the
        // fewest already queued first, so a burst that lands while the mini core is
        // still going down is spread over the whole set instead of one block.
        this.blocked.clear();
        let waiting = null;
        for (let step = 0; step < cells.length; step++) {
            const found = this.pending.get(cellKey(cells[(this.turn + step) % cells.length]));
            if (found && (!waiting || found.queue.length < waiting.queue.length)) waiting = found;
        }
        if (waiting) {
            waiting.queue.push(...list);
            // The turn moves on, so the next command takes another cell even before
            // this one has answered.
            const index = cells.findIndex(cell => cellKey(cell) === waiting.key);
            if (index !== -1) this.turn = (index + 1) % cells.length;
            return waiting.cell;
        }
        const cell = cells[this.turn];
        const key = cellKey(cell);
        const busy = this.slots.get(key);
        if (busy) {
            if (!this.writeAll(busy.cell, list, busy)) return null;
            return busy.cell;
        }
        return this.placeSlot(key, cell, list);
    }

    // Writes the commands of one operation into the block, one step at a time, and
    // digs the block up once the last of them has run: a block only ever holds a
    // command for as long as that command needs.
    writeAll(cell, commands, slot = null) {
        const list = [...commands];
        if (!list.length) return true;
        if (!this.write(cell, list.shift())) return false;
        list.forEach((command, index) => {
            const timer = setTimeout(() => this.write(cell, command), this.stepMs * (index + 1));
            timer.unref?.();
        });
        if (slot) {
            // Busy until the last step is out; after that the block holds a command
            // that has run and is free for the next one, until it is dug.
            slot.busyUntil = Date.now() + this.stepMs * list.length;
            this.scheduleBreak(cell, slot, this.stepMs * list.length + this.afterRunMs);
        }
        return true;
    }

    // The command has run: unless the block is used again first, it is dug up and
    // its cell is free for a fresh one. Every write pushes that back, so a burst
    // keeps its blocks and an idle mini core leaves nothing behind.
    scheduleBreak(cell, slot, after) {
        if (slot.breakTimer) clearTimeout(slot.breakTimer);
        const timer = setTimeout(() => {
            slot.breakTimer = null;
            const key = cellKey(slot.cell);
            if (this.slots.get(key) !== slot) return;
            this.slots.delete(key);
            this.breakAt(slot.cell);
        }, Math.max(Number(after) || 0, 0));
        timer.unref?.();
        slot.breakTimer = timer;
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

    // The bot moved away: the blocks are too far to be worth keeping, so they are
    // dug up and placed again around where the bot stands now.
    reposition() {
        for (const slot of this.slots.values()) {
            if (slot.breakTimer) clearTimeout(slot.breakTimer);
            slot.breakTimer = null;
            this.breakAt(slot.cell);
        }
        this.slots.clear();
        this.blocked.clear();
        this.pending.clear();
        this.turn = 0;
        this.origin = this.feet();
    }

    placeSlot(key, cell, commands, given = false) {
        if (!this.creative) {
            this.log.warn(
                `refill items need creative mode (the bot is in gamemode ${this.bot?.selfCare?.gamemode}); ` +
                'refilling through the core instead'
            );
            this.broken = true;
            return null;
        }

        this.lastSendAt = Date.now();
        if (!given && !this.give()) return null;

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
        const placement = {
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
        this.pending.set(key, placement);
        placement.timer = setTimeout(() => this.settle(placement), SETTLE_MS);
        placement.timer.unref?.();
        return cell;
    }

    // The placement is over: write the queued commands into the block that is
    // really there, or give up on this cell when nothing was placed.
    settle(placement) {
        if (this.pending.get(placement.key) !== placement) return;
        this.pending.delete(placement.key);
        if (placement.timer) clearTimeout(placement.timer);
        placement.timer = null;

        if (!placement.landed) {
            // Nothing was placed, or the server never said where it went: the
            // commands are lost either way, so the cell is not used again and the
            // next cell around the bot is tried.
            this.blocked.add(placement.key);
            this.log.debug(`nothing could be placed at ${placement.cell.x} ${placement.cell.y} ${placement.cell.z}; trying another cell`);
            return;
        }

        const at = { ...placement.landed };
        const slot = {
            cell: at,
            state: placement.state,
            placedAt: Date.now(),
            busyUntil: 0,
            breakTimer: null
        };
        this.slots.set(placement.key, slot);
        // A block placed ahead of the command it will carry goes again on its own
        // if no command reaches it, so the set is not left standing unused.
        if (!placement.queue.length) this.scheduleBreak(at, slot, IDLE_BLOCK_MS);
        this.writeAll(at, placement.queue, slot);
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
    // or the block of the layer below, so the layers grow upwards.
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

    // Only ever the mini core's own blocks: the core is not touched.
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

    // A block update at one of its own cells is the server's answer about
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

        for (const placement of [...this.pending.values()]) {
            if (Date.now() - placement.at >= SETTLE_MS + PENDING_MS) continue;
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
        for (const slot of this.slots.values()) {
            if (slot.breakTimer) clearTimeout(slot.breakTimer);
            slot.breakTimer = null;
        }
        this.slots.clear();
        this.origin = null;
        this.pending.clear();
        this.ringKey = null;
        this.ringCells = [];
    }
}

module.exports = { FillItem, commandBlockItem, blockMode, HOTBAR_SLOT, BLOCK, COUNT, MOVE_LIMIT };
