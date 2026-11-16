'use strict';

// The core is a cube of repeating command blocks. Commands are written into the
// blocks with the update_command_block packet, which keeps them off the chat log,
// and the area is refilled with /fill whenever something breaks a block.

const tellraw = require('./minecraft/tellraw');

const OWN_CHANGE_MS = 2500;
const DAMAGE_DELAY_MS = 250;
const REFILL_SETTLE_MS = 400;
const WATCHDOG_MS = 2000;

class Core {
    constructor({ bot, config, logger }) {
        this.bot = bot;
        this.log = logger;
        this.config = config || {};
        this.enabled = this.config.enabled !== false;

        this.size = positive(this.config.area?.size, 9);
        this.y = Number.isFinite(Number(this.config.area?.y)) ? Number(this.config.area.y) : 64;
        this.block = String(this.config.refill?.block || 'minecraft:repeating_command_block');
        // Optional display name, as raw SNBT component text, for example
        // {"text":"vbot","color":"green"} -> block{CustomName:'...'}.
        this.name = this.config.name ? String(this.config.name) : null;
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
        // key -> alive. Populated when a fill lands, then pruned by block changes.
        this.blocks = new Map();
        this.graceUntil = 0;
        this.watchdog = null;
        this.watchdogMs = positive(this.config.refill?.intervalMs, WATCHDOG_MS);
    }

    get volume() {
        return this.size ** 3;
    }

    status() {
        if (!this.enabled) return 'core is disabled in config';
        if (this.origin.x === null) return 'core not placed yet (no position seen)';
        const { origin, bounds } = this;
        return `core ${this.size}^3 at ${origin.x} ${origin.y} ${origin.z}..${bounds.x} ${bounds.y} ${bounds.z}, ` +
            `${this.ready ? 'ready' : this.refilling ? 'refilling' : 'not ready'}, cursor ${this.cursor}/${this.volume}, ` +
            `name ${this.name ? this.name : 'none'}`;
    }

    // The configured name as a component, so it keeps its colours in chat.
    nameParts() {
        if (!this.name) return [{ text: 'none', color: 'dark_gray' }];
        let component = this.name;
        try {
            component = JSON.parse(this.name);
        } catch {
            return [{ text: this.name, color: 'white' }];
        }
        return Array.isArray(component) ? component : [component];
    }

    // Status as tellraw parts rather than one string, so the name is coloured.
    statusParts() {
        if (!this.enabled) return [{ text: 'core is disabled in config', color: 'gray' }];
        if (this.origin.x === null) {
            return [{ text: 'core not placed yet (no position seen)', color: 'gray' }];
        }

        const { origin, bounds } = this;
        return [
            { text: 'core ', color: 'gray' },
            { text: `${this.size}^3`, color: 'aqua' },
            { text: ` at ${origin.x} ${origin.y} ${origin.z}..${bounds.x} ${bounds.y} ${bounds.z}, `, color: 'gray' },
            {
                text: this.ready ? 'ready' : this.refilling ? 'refilling' : 'not ready',
                color: this.ready ? 'green' : 'yellow'
            },
            { text: `, cursor ${this.cursor}/${this.volume}, name `, color: 'dark_gray' },
            ...this.nameParts()
        ];
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
        this.blocks.clear();
        this.log.info(`core area ${this.origin.x} ${this.origin.y} ${this.origin.z}`);
        return true;
    }

    refill(reason = 'manual') {
        if (!this.enabled || !this.refillEnabled) return false;
        if (this.origin.x === null && !this.reset()) return false;

        const { origin, bounds } = this;
        const block = this.blockSpec();
        const command =
            `fill ${origin.x} ${origin.y} ${origin.z} ${bounds.x} ${bounds.y} ${bounds.z} ${block} ${this.mode}`;

        // Refills always go out as chat. Writing the fill into a leftover block
        // cannot be trusted - that block may already be gone, or the write may
        // be ignored - and a refill is exactly when the core must not depend on
        // the core.
        const send = typeof this.bot.sendChat === 'function'
            ? text => this.bot.sendChat(text)
            : text => this.bot.chat(text);
        send(`/${command}`);

        this.refilling = true;
        this.ready = false;
        // The fill itself produces a block change per cell; those are ours.
        this.graceUntil = Date.now() + REFILL_SETTLE_MS + 500;
        this.log.info(`core refill (${reason}) via chat`);

        setTimeout(() => {
            this.refilling = false;
            this.ready = true;
            this.lastRefillAt = Date.now();
            this.markAllAlive();
        }, REFILL_SETTLE_MS).unref?.();

        return true;
    }

    // Spreads commands over the cube instead of hammering one block, so a
    // command never lands in the block that is currently executing. Destroyed
    // blocks are skipped, so a command is never written into nothing.
    run(command) {
        if (!this.enabled) return null;
        const text = String(command || '').trim().replace(/^\//, '');
        if (!text) return null;
        if (this.origin.x === null && !this.reset()) return null;

        for (let attempt = 0; attempt < this.volume; attempt++) {
            const cell = this.nextCell();
            if (!cell) return null;
            if (this.blocks.get(keyOf(cell)) === false) continue;

            this.markOwn(cell);
            const sent = this.bot.write
                ? this.bot.write('update_command_block', {
                    location: cell,
                    command: text.slice(0, 32000),
                    mode: 1,
                    flags: 0b101
                })
                : false;

            if (sent) return cell;

            this.ownChanges.delete(keyOf(cell));
            this.blocks.set(keyOf(cell), false);
            this.log.warn(`core block ${cell.x} ${cell.y} ${cell.z} did not accept a command`);
        }

        this.log.warn('no core block accepted the command');
        return null;
    }

    // The block as written in the fill command, with the configured name.
    // NBT text components changed in 1.21.5: a name used to be a JSON string
    // wrapped in quotes, and is now the component written inline.
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

    markAllAlive() {
        if (this.origin.x === null) return;
        for (let x = this.origin.x; x <= this.bounds.x; x++) {
            for (let y = this.origin.y; y <= this.bounds.y; y++) {
                for (let z = this.origin.z; z <= this.bounds.z; z++) {
                    this.blocks.set(`${x}:${y}:${z}`, true);
                }
            }
        }
    }

    // Any block still standing can run the fill, so one is enough.
    survivor() {
        if (this.origin.x === null) return null;
        for (const [id, alive] of this.blocks) {
            if (!alive) continue;
            const [x, y, z] = id.split(':').map(Number);
            return { x, y, z };
        }
        return null;
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
        this.startWatchdog();
    }

    // Nothing guarantees the fill landed: the bot may not be opped yet, a chunk
    // may not be loaded, or every block may have been broken. Every couple of
    // seconds, rebuild whatever is missing - through a leftover block when there
    // is one, and through chat when there is nothing left at all.
    startWatchdog() {
        if (this.watchdog || !this.enabled || !this.refillEnabled) return;
        this.watchdog = setInterval(() => {
            if (!this.enabled || this.refilling) return;
            const standing = this.survivor() !== null;
            if (this.ready && standing) return;
            if (this.origin.x === null && !this.reset()) return;
            this.log.info('core missing or incomplete; rebuilding');
            this.refill('watchdog');
        }, this.watchdogMs);
        this.watchdog.unref?.();
    }

    // Anything that changes a block inside the core that we did not write
    // ourselves means the area lost a block and needs rebuilding.
    onBlockChange(packet) {
        if (!this.enabled || !this.refillEnabled) return false;
        const location = packet?.location;
        if (!location || this.origin.x === null) return false;
        if (!this.inside(location.x, location.y, location.z)) return false;
        if (this.isOwn(location)) return false;
        // Changes made by our own fill are not damage.
        if (this.refilling || Date.now() < this.graceUntil) return false;

        this.blocks.set(keyOf(location), false);

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
        if (this.watchdog) {
            clearInterval(this.watchdog);
            this.watchdog = null;
        }
        this.ownChanges.clear();
        this.ready = false;
    }
}

function keyOf({ x, y, z }) {
    return `${x}:${y}:${z}`;
}

function positive(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = { Core };
