'use strict';

// The bot's own command block: a one-block mini core.
//
// It is placed once - `/item replace` puts a repeating command block into the
// mainhand whose block entity data already holds the fill and `auto: 1b`, and it
// is placed in the air next to the bot. From then on it is never broken: every
// later change is written into it with `update_command_block`, exactly how the
// main core's blocks are written, and the block runs the command against the
// main core itself. The core's blocks are therefore never edited directly while
// this block stands.
//
// The block is placed again when the bot has moved more than five blocks away
// from it, and a block update at its cell (mined, or replaced by a fill) means
// the next command places a fresh one.
//
// 1.21 and later only: that is where item components and block entity data in a
// command all exist. The `/item` calls here are the fill path's own use of chat;
// commands themselves never travel as chat.

const MAINHAND = 'weapon.mainhand';
const HOLD_MS = 250;             // how long the given item stays in the hand
const FACE_UP = 1;
const BLOCK = 'minecraft:repeating_command_block';
// All three command block types share one block entity id.
const BLOCK_ENTITY_ID = 'minecraft:command_block';
const MOVE_LIMIT = 5;            // place a new block once the bot has moved this far
const PLACE_ECHO_MS = 750;       // its own placement's block update is not damage

function snbtString(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The item as the command takes it: a command block that is always active and
// already holds the command, so placing it is all that is needed.
function commandBlockItem(command, block = BLOCK) {
    const tag = '{id:' + snbtString(BLOCK_ENTITY_ID) +
        ',Command:' + snbtString(String(command || '').replace(/^\//, '')) +
        ',auto:1b,TrackOutput:1b}';
    return `${block}[block_entity_data=${tag}]`;
}

// update_command_block carries the block's own mode, and the command has to be
// sent in the mode the block actually is.
function blockMode(block) {
    if (/chain_command_block$/.test(block)) return 0;
    if (/repeating_command_block$/.test(block)) return 1;
    return 2;
}

class FillItem {
    constructor({ bot, logger, config = {} }) {
        this.bot = bot;
        this.log = logger;
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

    get usable() {
        if (this.broken) return false;
        if (!this.bot || typeof this.bot.write !== 'function') return false;
        return typeof this.bot.sendChat === 'function';
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

    // `/item replace` puts the item with the command already inside it into the
    // mainhand, so the placed block starts running it straight away.
    give(command) {
        return this.bot.sendChat(
            `/item replace entity @s ${MAINHAND} with ${commandBlockItem(command, this.block)}`
        ) !== false;
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

    // The given item was never meant to stay in the inventory.
    clear() {
        return this.bot.sendChat(`/item replace entity @s ${MAINHAND} with minecraft:air`) !== false;
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

module.exports = { FillItem, commandBlockItem, blockMode, MAINHAND, BLOCK, MOVE_LIMIT };
