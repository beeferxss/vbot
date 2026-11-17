'use strict';

// The bot's own command blocks, in a small cube of its own: `miniSize` blocks on
// a side, four by default - size x size x size, 64 blocks - standing above the
// bot's head, each one named green.
//
// Nothing is taken out of the inventory and no block is ever placed by hand: the
// whole cube is one `/fill`, run through a core block that is still standing or,
// with none left, as chat. After that every command is a single
// `update_command_block` into one of its cells, exactly how the main core's own
// blocks are written.
//
// A cell only counts once the server has shown a command block there - the block
// update that comes with the fill, or the answer to a block query. Until then the
// cube is only planned, and nothing is written into it, so a server that drops the
// fill cannot swallow commands silently. A cell that turns to air, or to anything
// that is not a command block, is gone and the cube is filled again.
//
// The cube stays where it was built, like the main core does; it is filled again
// there when blocks go missing, and only moved once the bot is further away than
// MOVE_LIMIT. Nothing is dug up: a fill is what puts it down, and a fill is what
// removes it.

const BLOCK = 'repeating_command_block';
const SIDE = 4;                 // blocks on a side: 4 x 4 x 4
const MAX_SIDE = 8;             // a cube this big is 512 blocks, which is plenty
const MOVE_LIMIT = 64;          // the cube is only rebuilt once the bot is this far
const MINI_RETRY_MS = 60000;    // a cube that did not land is not asked for again for a while
const MINI_FILL_MS = 2000;      // one fill on its way at a time
const STEP_MS = 120;            // gap between the commands of one operation
const AIR = 0;                  // air's block state number in every version

const tellraw = require('./minecraft/tellraw');

function cellKey(cell) {
    return `${Math.floor(cell.x)}:${Math.floor(cell.y)}:${Math.floor(cell.z)}`;
}

function sameCell(a, b) {
    if (!a || !b) return false;
    return Math.floor(a.x) === Math.floor(b.x)
        && Math.floor(a.y) === Math.floor(b.y)
        && Math.floor(a.z) === Math.floor(b.z);
}

// A block change packet carries the new block state as a number on every version
// this handles; air is 0.
function blockState(packet) {
    const state = packet?.type ?? packet?.state ?? packet?.blockId;
    if (state === 'minecraft:air' || state === 'air') return AIR;
    const number = Number(state);
    return Number.isFinite(number) ? number : null;
}

// update_command_block carries the block's own mode.
function blockMode(block) {
    if (/chain_command_block$/.test(block)) return 0;
    if (/repeating_command_block$/.test(block)) return 1;
    return 2;
}

class MiniCore {
    constructor({ bot, logger, data = null, config = {} }) {
        this.bot = bot;
        this.log = logger;
        this.data = data;
        this.block = String(config.block || BLOCK);
        this.mode = blockMode(this.block);
        // The cube's own name, as a raw SNBT component: it is written into the fill,
        // so every block of the cube is named the same way.
        this.name = config.name ? String(config.name) : null;
        // A cube on a side, so the mini core is size x size x size: `miniSize`
        // directly, or the cube root of the old `itemCount` for a config that
        // still asks for a number of blocks.
        const count = Math.floor(Number(config.itemCount));
        const wanted = Math.floor(Number(config.miniSize))
            || (Number.isFinite(count) && count > 0 ? Math.round(Math.cbrt(count)) : SIDE);
        this.side = Math.min(Math.max(wanted, 1), MAX_SIDE);
        this.count = this.side ** 3;
        this.stepMs = Number(config.stepMs) > 0 ? Number(config.stepMs) : STEP_MS;
        // The cells the server has shown a command block in, by cell.
        this.slots = new Map();
        this.turn = 0;            // which cell the next command goes to
        // Where the cube is: the corner it was built from and its cells.
        this.box = null;
        this.boxKey = null;
        this.flushedAt = 0;       // when the fill for this cube was last sent
        this.retryUntil = 0;      // a fill that did not land is not repeated before this
        this.broken = false;
    }

    // Any cell of the cube the server has shown is up.
    get standing() {
        for (const slot of this.slots.values()) {
            if (slot.confirmed) return true;
        }
        return false;
    }

    // Cells that are standing and not still running a command: a command can go
    // into one of these without waiting.
    get ready() {
        const now = Date.now();
        let free = 0;
        for (const slot of this.slots.values()) {
            if (slot.confirmed && !(slot.busyUntil > now)) free += 1;
        }
        return free;
    }

    get usable() {
        if (this.broken) return false;
        if (Date.now() < this.retryUntil) return false;
        return Boolean(this.bot) && typeof this.bot.write === 'function';
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

    // The cube sits over the bot's head, so filling it never puts a block where
    // the bot stands: size x size x size, one level above its head.
    boxFor(at) {
        const side = this.side;
        const low = at.y + 2;
        const min = {
            x: at.x - Math.floor(side / 2),
            y: low,
            z: at.z - Math.floor(side / 2)
        };
        const max = { x: min.x + side - 1, y: low + side - 1, z: min.z + side - 1 };
        const cells = [];
        for (let y = min.y; y <= max.y; y++) {
            for (let x = min.x; x <= max.x; x++) {
                for (let z = min.z; z <= max.z; z++) cells.push({ x, y, z });
            }
        }
        return { min, max, cells };
    }

    // The cube currently planned or built, worked out from where the bot stands.
    current() {
        const at = this.feet();
        if (!at) return this.box;
        const key = `${at.x}:${at.y}:${at.z}`;
        if (this.box && this.boxKey === key) return this.box;
        if (this.box && !this.moved(at)) return this.box;
        if (this.box) this.forget();
        this.box = this.boxFor(at);
        this.boxKey = key;
        return this.box;
    }

    // Cells the cube has that the server has shown a command block in.
    cells() {
        return [...this.slots.values()].filter(slot => slot.confirmed).map(slot => ({ ...slot.cell }));
    }

    // Cells worth asking the server about: the ones standing, and while a fill is
    // still unanswered, the ones it was meant to put down.
    watchCells() {
        const confirmed = this.cells();
        if (confirmed.length) return confirmed;
        const box = this.current();
        if (!box) return [];
        if (!this.flushedAt || Date.now() - this.flushedAt > MINI_RETRY_MS) return [];
        return box.cells.map(cell => ({ ...cell }));
    }

    inBox(cell) {
        const box = this.current();
        if (!box || !cell) return false;
        const x = Math.floor(cell.x), y = Math.floor(cell.y), z = Math.floor(cell.z);
        return x >= box.min.x && x <= box.max.x
            && y >= box.min.y && y <= box.max.y
            && z >= box.min.z && z <= box.max.z;
    }

    moved(at) {
        if (!this.box) return true;
        const centre = {
            x: (this.box.min.x + this.box.max.x) / 2,
            y: (this.box.min.y + this.box.max.y) / 2,
            z: (this.box.min.z + this.box.max.z) / 2
        };
        return Math.hypot(at.x - centre.x, at.y - centre.y, at.z - centre.z) > MOVE_LIMIT;
    }

    // The whole cube in one command. The core runs it through a block that is
    // still standing, or as chat; either way one command puts the mini core down.
    fillCommand() {
        if (!this.usable) return null;
        const at = this.feet();
        if (!at) return null;

        const box = this.current();
        if (!box) return null;
        // Every cell already shown standing: there is nothing to fill, and a
        // fill that is still on its way is not sent twice.
        if (this.slots.size >= this.count && this.standing) return null;
        if (this.flushedAt && Date.now() - this.flushedAt < MINI_FILL_MS) return null;

        this.flushedAt = Date.now();
        return `fill ${box.min.x} ${box.min.y} ${box.min.z} ` +
            `${box.max.x} ${box.max.y} ${box.max.z} ${this.blockSpec()}`;
    }

    // The block as the fill writes it, with the name the cube is given. NBT text
    // components changed in 1.21.5: a name used to be a JSON string wrapped in
    // quotes, and is now the component written inline.
    blockSpec() {
        if (!this.name) return this.block;
        if (!tellraw.isModern(this.bot?.client?.version)) {
            return `${this.block}{CustomName:'${this.name.replace(/'/g, "\\'")}'}`;
        }

        let component = this.name;
        try {
            component = JSON.parse(this.name);
        } catch {
            // Already SNBT; use it as written.
            return `${this.block}{CustomName:${this.name}}`;
        }
        return `${this.block}{CustomName:${tellraw.snbt(component)}}`;
    }

    // The cube is not all there: a fill has not been answered at all, or cells of
    // it are gone. A cube with a hole in it is filled again where it stands, so a
    // few broken blocks are enough - the whole of it does not have to be gone.
    needsFill() {
        if (!this.usable) return false;
        if (!this.standing) return true;
        return this.slots.size < this.count;
    }

    // Cells of the cube the server has not shown a command block in.
    missingCells() {
        const box = this.current();
        if (!box) return [];
        return box.cells.filter(cell => !this.slots.get(cellKey(cell))?.confirmed);
    }

    // The fill did not land: the cube is not asked for again for a while, and the
    // core falls back to a block of its own or to chat.
    refused() {
        this.retryUntil = Date.now() + MINI_RETRY_MS;
        this.box = null;
        this.boxKey = null;
        this.slots.clear();
        return true;
    }

    // The cube moved: the old cells are not watched any more. Nothing is dug up.
    forget() {
        if (this.box && this.slots.size) {
            this.log?.debug?.('the mini core is left behind and built again where the bot stands now');
        }
        this.slots.clear();
        this.box = null;
        this.boxKey = null;
        this.turn = 0;
        // Nothing has been filled for the place the bot stands in now.
        this.flushedAt = 0;
    }

    // The server has shown a command block at this cell.
    confirm(cell) {
        if (!this.inBox(cell)) return false;
        const key = cellKey(cell);
        const slot = this.slots.get(key);
        if (slot) {
            slot.confirmed = true;
            slot.cell = { x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) };
            return true;
        }
        this.slots.set(key, {
            cell: { x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) },
            confirmed: true,
            busyUntil: 0
        });
        return true;
    }

    // A fill puts the whole cube down at once, so one cell answering as a command
    // block is the answer for all of them.
    confirmAll() {
        const box = this.current();
        if (!box) return 0;
        for (const cell of box.cells) this.confirm(cell);
        return box.cells.length;
    }

    // A cell of the cube that is no longer a command block is gone, and a cell
    // that is gone runs nothing: its slot is dropped, so the next fill puts the
    // cube back instead of a command being written into air. A deletion that
    // sends no block update at all (a WorldEdit fill, a /setblock from the
    // console) is only ever noticed this way.
    gone(cell) {
        const key = cellKey(cell);
        const slot = this.slots.get(key);
        if (!slot) return false;
        this.slots.delete(key);
        return true;
    }

    // The whole cube at once: a deletion that sends nothing is a bulk edit, and a
    // bulk edit takes every block of the mini core with it.
    goneAll() {
        const count = this.slots.size;
        if (!count) return 0;
        this.slots.clear();
        return count;
    }

    // A block update only says the state number. The bot's own blocks are command
    // blocks on every version, so a state that names anything else is not one of
    // them.
    isOwnState(state) {
        if (state === null || state === undefined) return false;
        if (state === AIR) return false;
        const byState = this.mcd()?.blocksByStateId?.[state];
        if (!byState) return true; // no palette for this version: trust the number
        return String(byState.name || '').includes('command_block');
    }

    mcd() {
        if (this.data === null) {
            try {
                // eslint-disable-next-line global-require
                this.data = require('minecraft-data')(this.bot?.client?.version || this.bot?.version);
            } catch {
                this.data = false;
            }
        }
        return this.data || null;
    }

    // A block update at one of the cube's cells is the server's answer about it:
    // a command block means the fill landed there, and anything else means that
    // block is not there any more.
    noteBlockChange(packet) {
        const location = packet?.location;
        if (!location) return false;
        const state = blockState(packet);
        const key = cellKey(location);
        const slot = this.slots.get(key);

        if (slot) {
            if (state === AIR) {
                this.slots.delete(key);
                return true;
            }
            if (this.isOwnState(state)) {
                slot.confirmed = true;
                return false;
            }
            this.slots.delete(key);
            return true;
        }

        if (this.inBox(location) && this.isOwnState(state)) {
            this.confirm(location);
            return false;
        }
        return false;
    }

    // Keeps a cell out of the rotation for a moment: it holds a command that has
    // to run before anything is written over it.
    busy(cell, ms = 500) {
        const slot = this.slots.get(cellKey(cell));
        if (!slot) return false;
        slot.busyUntil = Math.max(slot.busyUntil || 0, Date.now() + ms);
        return true;
    }

    // Writes commands into the mini core, one of its blocks at a time, taken in
    // turn: a block that is still running the command before is passed over, so
    // back-to-back commands are spread over the whole cube. Returns the cell the
    // commands were written to, or null when no cell of the cube is standing.
    run(...commands) {
        const list = commands
            .flat()
            .map(command => String(command || '').trim())
            .filter(Boolean);
        if (!list.length) return null;
        if (!this.usable) return null;
        if (typeof this.bot.write !== 'function') return null;

        const cells = this.cells();
        if (!cells.length) return null;
        const now = Date.now();

        for (let step = 0; step < cells.length; step++) {
            const index = (this.turn + step) % cells.length;
            const key = cellKey(cells[index]);
            const slot = this.slots.get(key);
            if (!slot || !slot.confirmed) continue;
            if (slot.busyUntil > now) continue;

            this.turn = (index + 1) % cells.length;
            if (!this.writeAll(slot.cell, list, slot)) return null;
            return slot.cell;
        }

        // Every cell is still running something: the command takes the one that is
        // free first, so a burst is not one block wide.
        let soonest = null;
        for (const slot of this.slots.values()) {
            if (!slot.confirmed) continue;
            if (!soonest || slot.busyUntil < soonest.busyUntil) soonest = slot;
        }
        if (!soonest || !this.writeAll(soonest.cell, list, soonest)) return null;
        return soonest.cell;
    }

    // Writes the commands of one operation into the block, one step at a time, so
    // a `setblock air` and the `setblock` that follows it never land in the same
    // tick.
    writeAll(cell, commands, slot = null) {
        const list = [...commands];
        if (!list.length) return true;
        if (!this.write(cell, list.shift())) return false;
        list.forEach((command, index) => {
            const timer = setTimeout(() => this.write(cell, command), this.stepMs * (index + 1));
            timer.unref?.();
        });
        if (slot) {
            slot.busyUntil = Date.now() + this.stepMs * list.length;
        }
        return true;
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

    destroy() {
        this.slots.clear();
        this.box = null;
        this.boxKey = null;
        this.turn = 0;
        this.flushedAt = 0;
        this.retryUntil = 0;
    }
}

module.exports = { MiniCore, blockMode, BLOCK, SIDE, MOVE_LIMIT, MINI_RETRY_MS };
