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

function atLeast(version, want) {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? ''));
    if (!match) return true; // unknown: assume a current server
    const have = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
    for (let index = 0; index < want.length; index++) {
        if (have[index] !== want[index]) return have[index] > want[index];
    }
    return true;
}

// 1.20.5 moved item data from NBT into typed data components.
function usesComponents(version) {
    return atLeast(version, [1, 20, 5]);
}

// 1.21.5 stopped describing a component's NBT in the packet and started sending
// it as raw anonymous-NBT bytes, so the same tag has to be encoded by hand.
function usesNbtBytes(version) {
    return atLeast(version, [1, 21, 5]);
}

function anonymousNbt(value) {
    const size = nbt.proto.sizeOf(value, 'anonymousNbt');
    const buffer = Buffer.alloc(size);
    nbt.proto.write(value, buffer, 0, 'anonymousNbt');
    return buffer;
}

// The same tag, in whatever form this version's packets want it.
function componentData(value, version) {
    return usesNbtBytes(version) ? anonymousNbt(value) : value;
}

// BlockEntityTag is where a command block keeps its command (and `auto`, the
// "always active" flag that makes it run as it is placed). The `id` is not
// optional in the modern block_entity_data component: vanilla wants to know
// which block entity this tag belongs to, and drops an item without it.
function blockEntityTag(command) {
    return nbt.comp({
        id: nbt.string('minecraft:command_block'),
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
            addedComponentCount: 1,
            removedComponentCount: 0,
            components: [{ type: 'block_entity_data', data: componentData(tag, version) }],
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
        // The server sends the slot back when it accepts a creative slot, so an
        // item that never comes back was never given.
        this.confirmed = false;
        this.misses = 0;
        this.broken = false;
    }

    // Needs a client, a version the data knows, and a command block in that data.
    get usable() {
        if (this.broken) return false;
        if (!this.bot || typeof this.bot.write !== 'function') return false;
        const data = this.mcd();
        return Boolean(data?.itemsByName?.command_block?.id !== undefined);
    }

    // Creative is the only mode where a creative slot is accepted at all.
    get creative() {
        const mode = this.bot?.selfCare?.gamemode;
        return mode === null || mode === undefined || mode === 1;
    }

    noteSlot(packet) {
        if (Number(packet?.slot) !== HOTBAR_SLOT) return;
        const item = packet?.item;
        if (item && (item.itemCount ?? 0) > 0) this.confirmed = true;
    }

    mcd() {
        if (this.data === null) {
            try {
                // eslint-disable-next-line global-require
                this.data = require('minecraft-data')(this.version());
            } catch {
                this.data = false;
            }
            if (this.data === false) {
                this.log.warn(
                    `no item data for protocol ${this.version() ?? 'unknown'}, so refill items are off ` +
                    '(pin minecraft.version to a version this bot knows)'
                );
            }
        }
        if (this.data && !this.data.itemsByName?.command_block) {
            this.log.warn(`the item data for ${this.version()} has no command_block`);
            this.broken = true;
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

        if (!this.creative) {
            this.log.warn(
                `refill items need creative mode (the bot is in gamemode ${this.bot?.selfCare?.gamemode}); ` +
                'refilling through the core blocks instead'
            );
            this.broken = true;
            return false;
        }

        this.confirmed = false;
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
            this.checkGiven();
        }, this.breakDelayMs);
        this.timer.unref?.();

        return true;
    }

    // The slot never came back: this server will not take the item, so stop
    // asking and leave refills to the core blocks.
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
        if (this.misses >= 2) {
            this.broken = true;
            this.log.warn('giving up on refill items: refilling through the core blocks instead');
        }
    }

    destroy() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.placed = null;
    }
}

module.exports = {
    FillItem,
    commandBlockItem,
    usesComponents,
    usesNbtBytes,
    blockEntityTag,
    HOTBAR_SLOT
};
