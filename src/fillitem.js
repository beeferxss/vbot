'use strict';

// Refilling through a command block *item* instead of writing into the core.
// `/item replace` puts a command block into the bot's mainhand whose block entity
// data already holds the fill and `auto: 1b`; it is then placed in the air at the
// bot's feet, runs the fill by itself, and is broken again a moment later.
// Nothing is written into the block afterwards and no item id is involved: the
// command takes the block by name.
//
// 1.21 and later only: that is where item components and block entity data in a
// command all exist. The `/item` and `/clear` of this path are the fill's own use
// of chat; the fill command itself never travels as chat.

const MAINHAND = 'weapon.mainhand';
const BREAK_DELAY_MS = 250;
const FACE_UP = 1;
const BLOCK = 'minecraft:repeating_command_block';
// All three command block types share one block entity id.
const BLOCK_ENTITY_ID = 'minecraft:command_block';

function snbtString(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The item as the command takes it: a repeating command block that is always
// active and already holds the fill, so placing it is all that is needed.
function commandBlockItem(command, block = BLOCK) {
    const tag = '{id:' + snbtString(BLOCK_ENTITY_ID) +
        ',Command:' + snbtString(String(command || '').replace(/^\//, '')) +
        ',auto:1b,TrackOutput:1b}';
    return `${block}[block_entity_data=${tag}]`;
}

class FillItem {
    constructor({ bot, logger, config = {} }) {
        this.bot = bot;
        this.log = logger;
        this.breakDelayMs = Number(config.breakDelayMs) > 0 ? Number(config.breakDelayMs) : BREAK_DELAY_MS;
        this.block = String(config.itemBlock || BLOCK);
        this.sequence = 0;
        this.timer = null;
        this.placed = null;
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

    // Command blocks can only be placed in creative.
    get creative() {
        const mode = this.bot?.selfCare?.gamemode;
        return mode === null || mode === undefined || mode === 1;
    }

    nextSequence() {
        this.sequence = (this.sequence + 1) % 32768;
        return this.sequence;
    }

    // The mainhand is the selected hotbar slot, so the item is in hand as soon as
    // the server runs the command: no slot has to be chosen.
    give(command) {
        return this.bot.sendChat(
            `/item replace entity @s ${MAINHAND} with ${commandBlockItem(command, this.block)}`
        ) !== false;
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

    // Give, place (the block runs the fill straight away), and break it after a
    // moment. One cycle at a time: the next placement would land in the block
    // still standing.
    run(command) {
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

        this.lastSendAt = Date.now();
        if (!this.give(command)) return false;

        const placed = this.place();
        if (!placed) {
            this.clear();
            return false;
        }

        this.placed = placed;
        this.timer = setTimeout(() => {
            this.timer = null;
            const location = this.placed;
            this.placed = null;
            this.breakAt(location);
            this.clear();
        }, this.breakDelayMs);
        this.timer.unref?.();

        return true;
    }

    destroy() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.placed = null;
    }
}

module.exports = { FillItem, commandBlockItem, MAINHAND, BLOCK };
