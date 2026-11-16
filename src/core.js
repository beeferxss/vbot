'use strict';

// The core is a cube of repeating command blocks. Commands are written into the
// blocks with the update_command_block packet, which keeps them off the chat log,
// and the area is refilled with /fill whenever something breaks a block.

const OWN_CHANGE_MS = 2500;
const DAMAGE_DELAY_MS = 250;
const REFILL_SETTLE_MS = 400;

class Core {
    constructor({ bot, config, logger }) {
        this.bot = bot;
        this.log = logger;
        this.config = config || {};
        this.enabled = this.config.enabled !== false;

        this.size = positive(this.config.area?.size, 16);
        this.y = Number.isFinite(Number(this.config.area?.y)) ? Number(this.config.area.y) : 64;
        this.block = String(this.config.refill?.block || 'minecraft:repeating_command_block');
        this.mode = String(this.config.refill?.mode || 'replace');
        this.refillEnabled = this.config.refill?.enabled !== false;

        this.origin = { x: null, y: this.y, z: null };
        this.bounds = { x: null, y: this.y + this.size - 1, z: null };
        this.cursor = 0;
        this.ready = false;
        this.refilling = false;
        this.damageTimer = null;
        this.ownChanges = new Map();
        this.lastRefillAt = 0;
    }

    get volume() {
        return this.size ** 3;
    }

    status() {
        if (!this.enabled) return 'core is disabled in config';
        if (this.origin.x === null) return 'core not placed yet (no position seen)';
        const { origin, bounds } = this;
        return `core ${this.size}^3 at ${origin.x} ${origin.y} ${origin.z}..${bounds.x} ${bounds.y} ${bounds.z}, ` +
            `${this.ready ? 'ready' : this.refilling ? 'refilling' : 'not ready'}, cursor ${this.cursor}/${this.volume}`;
    }

    // Grid-aligned to the bot's chunk so the core stays put while it walks.
    reset(position = this.bot.position) {
        if (!this.enabled) return false;
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return false;

        const x = Math.floor(position.x / this.size) * this.size;
        const z = Math.floor(position.z / this.size) * this.size;

        this.origin = { x, y: this.y, z };
        this.bounds = { x: x + this.size - 1, y: this.y + this.size - 1, z: z + this.size - 1 };
        this.cursor = 0;
        this.ready = false;
        this.ownChanges.clear();
        this.log.info(`core area ${this.origin.x} ${this.origin.y} ${this.origin.z}`);
        return true;
    }

    refill(reason = 'manual') {
        if (!this.enabled || !this.refillEnabled) return false;
        if (this.origin.x === null && !this.reset()) return false;

        const { origin, bounds } = this;
        const command =
            `fill ${origin.x} ${origin.y} ${origin.z} ${bounds.x} ${bounds.y} ${bounds.z} ${this.block} ${this.mode}`;

        // The first fill has no command block to run it, so it goes through chat.
        // Once the core exists, refills are written into a block like any other
        // command, which keeps them out of the server log.
        const viaCore = this.ready && !this.refilling && this.run(command);
        if (!viaCore) this.bot.chat(`/${command}`);

        this.refilling = true;
        this.ready = false;
        this.log.info(`core refill (${reason})${viaCore ? ' via core' : ' via chat'}`);

        setTimeout(() => {
            this.refilling = false;
            this.ready = true;
            this.lastRefillAt = Date.now();
        }, REFILL_SETTLE_MS).unref?.();

        return true;
    }

    // Spreads commands over the cube instead of hammering one block, so a
    // command never lands in the block that is currently executing.
    run(command) {
        if (!this.enabled) return null;
        const text = String(command || '').trim().replace(/^\//, '');
        if (!text) return null;
        if (this.origin.x === null && !this.reset()) return null;

        const cell = this.nextCell();
        if (!cell) return null;

        this.markOwn(cell);
        try {
            this.bot.write('update_command_block', {
                location: cell,
                command: text.slice(0, 32000),
                mode: 1,
                flags: 0b101
            });
        } catch (error) {
            this.log.error(`core write failed: ${error.message}`);
            return null;
        }
        return cell;
    }

    nextCell() {
        if (this.origin.x === null) return null;
        const index = this.cursor++ % this.volume;
        const width = this.size;
        const area = width * width;

        const x = this.origin.x + (index % width);
        const y = this.origin.y + (Math.floor(index / width) % width);
        const z = this.origin.z + Math.floor(index / area);
        return { x, y, z };
    }

    inside(x, y, z) {
        if (this.origin.x === null) return false;
        const { origin, bounds } = this;
        return x >= origin.x && x <= bounds.x &&
            y >= origin.y && y <= bounds.y &&
            z >= origin.z && z <= bounds.z;
    }

    markOwn({ x, y, z }) {
        this.ownChanges.set(`${x}:${y}:${z}`, Date.now() + OWN_CHANGE_MS);
    }

    isOwn({ x, y, z }) {
        const key = `${x}:${y}:${z}`;
        const expires = this.ownChanges.get(key);
        if (!expires) return false;
        if (Date.now() >= expires) {
            this.ownChanges.delete(key);
            return false;
        }
        return true;
    }

    onReady() {
        if (!this.enabled) return;
        if (this.origin.x === null) this.reset();
        if (this.origin.x !== null) this.refill('startup');
    }

    // Anything that changes a block inside the core that we did not write
    // ourselves means the area lost a block and needs rebuilding.
    onBlockChange(packet) {
        if (!this.enabled || !this.refillEnabled) return false;
        const location = packet?.location;
        if (!location || this.origin.x === null) return false;
        if (!this.inside(location.x, location.y, location.z)) return false;
        if (this.isOwn(location)) return false;

        if (this.damageTimer) return false;
        this.damageTimer = setTimeout(() => {
            this.damageTimer = null;
            this.refill('damaged');
        }, DAMAGE_DELAY_MS).unref?.();
        return true;
    }

    destroy() {
        if (this.damageTimer) {
            clearTimeout(this.damageTimer);
            this.damageTimer = null;
        }
        this.ownChanges.clear();
        this.ready = false;
    }
}

function positive(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = { Core };
