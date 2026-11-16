'use strict';

// Filling the core with a command block *item* rather than by writing into the
// core: the bot puts a command block in its hotbar with the fill baked in and
// "always active" set, places it in the air, and breaks that one block a moment
// later. An impulse command block runs its command the instant it is placed, so
// one placement is one fill - and nothing in the core has to be touched.
//
// Everything goes through packets: no /give, no chat.

const nbt = require('prismarine-nbt');

const HOTBAR_SLOT = 36;          // first hotbar slot, packet slot numbering
const BREAK_DELAY_MS = 250;
const FACE_UP = 1;

// 1.20.5 moved item data from NBT into typed data components.
function usesComponents(version) {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? ''));
    if (!match) return true;
    const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
    if (major !== 1) return major > 1;
    if (minor !== 20) return minor > 20;
    return patch >= 5;
}

// BlockEntityTag is where a command block keeps its command (and `auto`, the
// "always active" flag that makes it run as it is placed).
function blockEntityTag(command) {
    return nbt.comp({
        Command: nbt.string(command),
        auto: nbt.byte(1),
        TrackOutput: nbt.byte(1)
    });
}

// The item as the server wants it: components on 1.20.5+, NBT before that.
function commandBlockItem({ version, itemId, command }) {
    if (usesComponents(version)) {
        const tag = blockEntityTag(command);
        return {
            present: true,
            itemCount: 1,
            itemId,
            addedComponentCount: 2,
            removedComponentCount: 0,
            components: [
                { type: 'block_entity_data', data: tag },
                { type: 'custom_data', data: nbt.comp({ BlockEntityTag: tag }) }
            ],
            removeComponents: []
        };
    }

    return {
        present: true,
        itemCount: 1,
        itemId,
        nbtData: nbt.comp({ BlockEntityTag: blockEntityTag(command) })
    };
}

class FillItem {
    constructor({ bot, logger, data = null, config = {} }) {
        this.bot = bot;
        this.log = logger;
        this.data = data;
        this.breakDelayMs = Number(config.breakDelayMs) > 0 ? Number(config.breakDelayMs) : BREAK_DELAY_MS;
        this.sequence = 0;
        this.timer = null;
        this.placed = null;
    }

    // Needs a client, a version the data knows, and a command block in that data.
    get usable() {
        if (!this.bot || typeof this.bot.write !== 'function') return false;
        const data = this.mcd();
        return Boolean(data?.itemsByName?.command_block?.id !== undefined);
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

    nextSequence() {
        this.sequence = (this.sequence + 1) % 32768;
        return this.sequence;
    }

    // Two packets: the item into the hotbar, and the hotbar slot selected.
    give(command) {
        const data = this.mcd();
        const itemId = data?.itemsByName?.command_block?.id;
        if (itemId === undefined) return false;

        const item = commandBlockItem({ version: this.version(), itemId, command });
        if (!this.bot.write('set_creative_slot', { slot: HOTBAR_SLOT, item })) return false;
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

    // Only ever this block: the core is not touched.
    breakAt(location) {
        this.bot.write('block_dig', {
            status: 0,
            location,
            face: FACE_UP,
            sequence: this.nextSequence()
        });
    }

    // A creative slot is only cleared by overwriting it with nothing, which is
    // a different shape before and after 1.20.5.
    emptyItem() {
        if (usesComponents(this.version())) {
            return { itemCount: 0, components: [], removeComponents: [] };
        }
        return { present: false };
    }

    clear() {
        return this.bot.write('set_creative_slot', { slot: HOTBAR_SLOT, item: this.emptyItem() });
    }

    // Give, place, and break that block after a moment. One cycle at a time:
    // the next placement would land in the block still standing.
    run(command) {
        if (!this.usable) return false;
        if (this.timer) return false;

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

module.exports = { FillItem, commandBlockItem, usesComponents, blockEntityTag, HOTBAR_SLOT };
