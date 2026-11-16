'use strict';

// The core is a cube of command blocks. Commands are written into the blocks with
// the update_command_block packet, which keeps them off the chat log, and the
// area is refilled with /fill whenever something breaks a block.

const tellraw = require('./minecraft/tellraw');
const { FillItem } = require('./fillitem');

const OWN_CHANGE_MS = 2500;
const DAMAGE_DELAY_MS = 250;
const REFILL_SETTLE_MS = 200;
const WATCHDOG_MS = 1000;
const DEFAULT_SPAM_MS = 250;
const DEFAULT_SPAM_SECONDS = 10;
// A fill's own block updates can arrive a second or more later, and a refill
// twice in a row is never useful, so both the grace and the rate limit are
// generous. Without them one slow update looped refills forever.
const REFILL_GRACE_MS = 3000;
const REFILL_MIN_INTERVAL_MS = 1500;

class Core {
    constructor({ bot, config, logger }) {
        this.bot = bot;
        this.log = logger;
        this.config = config || {};
        this.enabled = this.config.enabled !== false;

        this.size = positive(this.config.area?.size, 9);
        this.y = Number.isFinite(Number(this.config.area?.y)) ? Number(this.config.area.y) : 64;
        this.block = String(this.config.refill?.block || 'minecraft:command_block');
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
        // A burst of refills through the blocks, for when the area has to be back
        // now rather than eventually.
        this.spamTimer = null;
        this.spam = null;
        this.spamMs = positive(this.config.refill?.spamMs, DEFAULT_SPAM_MS);
        // The fastest refill path: a command block item placed and broken again.
        this.fillItem = this.config.refill?.item === false
            ? null
            : new FillItem({ bot, logger, config: this.config.refill });
        this.itemFills = 0;
        // Result the server reported for the last fill it ran for us.
        this.lastFill = null;
        this.fillFailures = 0;
        // Where the last command landed, and the queries waiting for an answer.
        this.lastLocation = null;
        this.client = null;
        this.queryId = 1;
        this.queries = new Map();
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

    // The server reports how many blocks a fill changed, and that is the only
    // confirmation we get: a fill that changed nothing never ran. Servers send
    // this as a translated key, so the raw text carries the count.
    noteMessage(line) {
        const text = String(line || '');

        // The count is how many blocks the fill *changed*, not how many it set,
        // so a small number is normal: a core already in place changes nothing.
        const success = /commands\.fill\.success(\d+)/i.exec(text)
            || /Successfully filled (\d+)/i.exec(text);
        if (success) {
            const blocks = Number(success[1]);
            this.lastFill = { blocks, expected: this.volume, ok: true, at: Date.now() };
            this.fillFailures = 0;
            this.log.info(blocks === 0
                ? 'core fill changed nothing: the core is already in place'
                : `core fill changed ${blocks} block(s)`);
            return true;
        }

        const failed = /commands\.fill\.failed/i.test(text)
            || /No blocks were filled/i.test(text)
            || /commands\.fill\.no\\?/i.test(text);
        if (failed) {
            // "No blocks were filled" is also what the server says when every
            // block already matches, which is the good case: standing blocks
            // mean there is nothing to repair, so this is not a failure.
            if (this.survivor()) {
                this.markAllAlive();
                this.ready = true;
                this.lastFill = { blocks: 0, expected: this.volume, ok: true, at: Date.now() };
                this.fillFailures = 0;
                this.log.info('core fill changed nothing: the core is already in place');
            } else {
                this.lastFill = { blocks: 0, expected: this.volume, ok: false, at: Date.now() };
                this.fillFailures += 1;
                this.log.warn(
                    'core fill failed and no core blocks are standing ' +
                    '(not opped, protected area, or an unloaded chunk?)'
                );
            }
            return true;
        }

        return false;
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
            ...this.nameParts(),
            ...(this.lastFill
                ? [{
                    text: this.lastFill.ok === false
                        ? ', last fill failed'
                        : `, last fill changed ${this.lastFill.blocks}`,
                    color: this.lastFill.ok === false ? 'red' : 'dark_gray'
                }]
                : [])
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

    // viaChat forces the fill out as a chat command instead of a block write.
    // Automatic refills prefer a block; the explicit command asks for chat.
    refill(reason = 'manual', { viaChat = false, force = false } = {}) {
        if (!this.enabled || !this.refillEnabled) return false;
        if (this.origin.x === null && !this.reset()) return false;

        // Never refill on top of a refill: the block updates from the last fill
        // look like damage, and reacting to them loops forever.
        if (!force && this.refilling) return false;
        if (!force && Date.now() - this.lastRefillAt < REFILL_MIN_INTERVAL_MS) {
            this.log.debug(`core refill (${reason}) skipped, last one was too recent`);
            return false;
        }

        const command = this.fillCommand();

        // Plain chat, never routed back into the core: a fill must reach the
        // server even when the core is the thing that is broken.
        const send = typeof this.bot.sendChat === 'function'
            ? text => this.bot.sendChat(text)
            : text => this.bot.chat(text);

        // Fastest first: place a command block item carrying the fill, which runs
        // the moment it lands, and break that one block again a moment later.
        let viaCore = false;
        const viaItem = !viaChat && this.placeFill(command);
        if (viaItem) viaCore = true;

        // Next best: reuse a block that is still standing, writing the fill into
        // it without a chat command. Only when neither works does an automatic
        // refill fall back to chat.
        const survivor = !viaChat && !viaCore && !this.refilling ? this.survivor() : null;

        if (survivor) {
            this.markOwn(survivor);
            viaCore = Boolean(this.bot.write?.('update_command_block', {
                location: survivor,
                command,
                mode: this.blockMode(),
                flags: 0b101
            }));
            if (!viaCore) this.blocks.set(keyOf(survivor), false);
        }

        if (!viaCore) send(`/${command}`);

        this.refilling = true;
        this.ready = false;
        // The fill itself produces a block change per cell; those are ours.
        this.graceUntil = Date.now() + REFILL_GRACE_MS;
        let place = 'chat';
        if (viaItem) place = 'a placed command block';
        else if (viaCore && survivor) place = `block ${survivor.x} ${survivor.y} ${survivor.z}`;
        this.log.info(`core refill (${reason}) via ${place}`);

        setTimeout(() => {
            this.refilling = false;
            this.ready = true;
            this.lastRefillAt = Date.now();
            this.markAllAlive();
        }, REFILL_SETTLE_MS).unref?.();

        return true;
    }

    // Places the fill as a command block item and breaks only that block. False
    // when the server or the version will not take the item.
    placeFill(command) {
        if (!this.fillItem?.usable) return false;
        if (!this.fillItem.run(command)) return false;
        this.itemFills += 1;
        return true;
    }

    // The fill that rebuilds the whole area, as a bare command.
    fillCommand() {
        const { origin, bounds } = this;
        return `fill ${origin.x} ${origin.y} ${origin.z} ` +
            `${bounds.x} ${bounds.y} ${bounds.z} ${this.blockSpec()} ${this.mode}`;
    }

    // A burst of refills through the blocks. Nothing goes out as chat, so the
    // area can be rebuilt several times a second: each write lands in a command
    // block and runs on the next tick, which is as fast as the server goes.
    startSpam({ intervalMs, durationMs } = {}) {
        if (!this.enabled || !this.refillEnabled) return false;
        if (this.spamTimer) return false;
        if (this.origin.x === null && !this.reset()) return false;

        const every = positive(intervalMs, this.spamMs);
        const total = positive(durationMs, DEFAULT_SPAM_SECONDS * 1000);
        this.spam = { startedAt: Date.now(), count: 0, intervalMs: every, durationMs: total };

        this.spamTimer = setInterval(() => {
            if (!this.enabled || !this.refillEnabled) return this.stopSpam('disabled');
            if (Date.now() - this.spam.startedAt >= this.spam.durationMs) return this.stopSpam('finished');

            // Our own fills change blocks; none of that is damage.
            this.graceUntil = Date.now() + REFILL_GRACE_MS;
            const command = this.fillCommand();
            if (this.placeFill(command) || this.run(command)) this.spam.count += 1;
        }, every);
        this.spamTimer.unref?.();

        this.log.info(`core spam refill: every ${every}ms for ${total}ms`);
        return true;
    }

    stopSpam(reason = 'stopped') {
        if (!this.spamTimer) return false;
        clearInterval(this.spamTimer);
        this.spamTimer = null;

        const count = this.spam?.count || 0;
        this.spam = null;
        this.graceUntil = Date.now() + REFILL_GRACE_MS;
        this.ready = true;
        this.lastRefillAt = Date.now();
        this.markAllAlive();
        this.log.info(`core spam refill ${reason} after ${count} fill(s)`);
        return true;
    }

    spamStatus() {
        if (!this.spam) return { running: false, intervalMs: this.spamMs };
        return {
            running: true,
            intervalMs: this.spam.intervalMs,
            count: this.spam.count,
            leftMs: Math.max(0, this.spam.durationMs - (Date.now() - this.spam.startedAt))
        };
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
                    mode: this.blockMode(),
                    flags: 0b101
                })
                : false;

            if (sent) {
                this.lastLocation = cell;
                return cell;
            }

            this.ownChanges.delete(keyOf(cell));
            this.blocks.set(keyOf(cell), false);
            this.log.warn(`core block ${cell.x} ${cell.y} ${cell.z} did not accept a command`);
        }

        this.log.warn('no core block accepted the command');
        return null;
    }

    // Listens for the reply to a block NBT query. The packet is called
    // nbt_query_response in every version from 1.16 to 1.21; the generic packet
    // hook is there in case a version renames it.
    bindClient(client) {
        if (!client || this.client === client) return;
        this.client = client;

        client.on('nbt_query_response', packet => this.onQueryResponse(packet));
        client.on('packet', (data, meta) => {
            const name = meta?.name || '';
            if (!/query.*nbt|nbt.*query/i.test(name)) return;
            this.onQueryResponse(data);
        });
    }

    onQueryResponse(packet) {
        if (!packet) return false;
        const pending = this.queries.get(packet.transactionId);
        if (!pending) return false;

        this.queries.delete(packet.transactionId);
        clearTimeout(pending.timer);
        pending.resolve(parseLastOutput(packet.nbt));
        return true;
    }

    // Runs a command in a core block and returns what the block printed, or null
    // if nothing answered. The block's output is only readable by asking the
    // server for the block's NBT, so a query follows the write.
    runTracked(command, { delay = 150, timeout = 3000 } = {}) {
        this.lastLocation = null;
        const cell = this.run(command);
        if (!cell) return Promise.resolve(null);

        const transactionId = this.queryId++;
        return new Promise(resolve => {
            // Both timers are ref'd on purpose: a caller awaiting the result must
            // keep the process alive until it arrives or times out.
            const timer = setTimeout(() => {
                this.queries.delete(transactionId);
                resolve(null);
            }, timeout);
            this.queries.set(transactionId, { resolve, timer });

            const ask = setTimeout(() => {
                const sent = this.bot.write
                    ? this.bot.write('query_block_nbt', { transactionId, location: cell })
                    : false;
                if (sent !== false) return;

                if (!this.queries.delete(transactionId)) return;
                clearTimeout(timer);
                resolve(null);
            }, delay);
        });
    }

    // The block as written in the fill command, with the configured name.
    // NBT text components changed in 1.21.5: a name used to be a JSON string
    // wrapped in quotes, and is now the component written inline.
    // update_command_block carries the block's own mode, so it has to match the
    // block: sending "repeating" for an impulse block fights its type.
    blockMode() {
        if (/repeating_command_block$/.test(this.block)) return 1;
        if (/chain_command_block$/.test(this.block)) return 0;
        return 2;
    }

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
            // Only a fill we know was refused counts as unfinished; a fill that
            // changed nothing is a core that is already in place.
            const filled = this.lastFill?.ok !== false;
            if (this.ready && standing && filled) return;
            if (this.origin.x === null && !this.reset()) return;

            // A server that keeps refusing needs backoff, not a fill every tick.
            if (!filled && this.fillFailures >= 3 && Date.now() - (this.lastFill?.at || 0) < 30000) {
                return;
            }

            this.log.info(`core missing or incomplete (${standing ? 'blocks standing' : 'no blocks'}, ` +
                `${filled ? 'fill ok' : 'fill incomplete'}); rebuilding`);
            // The watchdog is the safety net, so it is allowed past the rate limit.
            this.refill('watchdog', { viaChat: !filled, force: true });
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
        if (Date.now() - this.lastRefillAt < REFILL_GRACE_MS) return false;

        this.blocks.set(keyOf(location), false);

        if (this.damageTimer) return false;
        this.damageTimer = setTimeout(() => {
            this.damageTimer = null;
            // Damage is its own reason to refill: the fill that just ran did not
            // take, so waiting out the look-before-you-refill gap helps nobody.
            this.refill('damaged', { force: true });
        }, DAMAGE_DELAY_MS).unref?.();
        return true;
    }

    destroy() {
        this.fillItem?.destroy();
        if (this.spamTimer) {
            clearInterval(this.spamTimer);
            this.spamTimer = null;
            this.spam = null;
        }
        for (const pending of this.queries.values()) {
            clearTimeout(pending.timer);
            pending.resolve(null);
        }
        this.queries.clear();
        this.client = null;
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

function findKey(node, wanted) {
    if (!node || typeof node !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(node, wanted)) return node[wanted];
    for (const value of Object.values(node)) {
        const found = findKey(value, wanted);
        if (found !== undefined) return found;
    }
    return undefined;
}

// 1.20.2+ hands NBT over typed ({type, value}); older versions hand over plain
// objects. Both end up as plain JS here.
function simplifyNbt(node) {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(simplifyNbt);
    if (typeof node.type === 'string' && 'value' in node) {
        const value = node.value;
        if (node.type === 'compound') {
            const out = {};
            for (const key of Object.keys(value || {})) out[key] = simplifyNbt(value[key]);
            return out;
        }
        if (node.type === 'list') {
            const items = value && Array.isArray(value.value) ? value.value : [];
            const type = value && value.type;
            return items.map(item => (type === 'compound' && item && typeof item === 'object'
                ? simplifyNbt({ type: 'compound', value: item })
                : simplifyNbt(item)));
        }
        return value;
    }
    return node;
}

function flattenComponent(component) {
    if (component === null || component === undefined) return '';
    if (typeof component === 'string' || typeof component === 'number' || typeof component === 'boolean') {
        return String(component);
    }
    if (Array.isArray(component)) return component.map(flattenComponent).join('');

    let out = '';
    if (component.text !== undefined) out += flattenComponent(component.text);
    else if (component.translate !== undefined) {
        out += String(component.translate);
        const args = component.with || component.args;
        if (Array.isArray(args)) out += ' ' + args.map(flattenComponent).join(' ');
    }
    // A component wraps bare strings as { "": "text" }.
    if (component[''] !== undefined) out += flattenComponent(component['']);
    if (component.extra) out += flattenComponent(component.extra);
    return out;
}

// Pulls LastOutput out of the block's NBT and turns it into plain text.
function parseLastOutput(nbt) {
    const found = findKey(nbt, 'LastOutput');
    if (found === undefined) return null;

    let raw = simplifyNbt(found);
    if (typeof raw === 'string') {
        if (!raw) return null;
        try {
            raw = JSON.parse(raw);
        } catch {
            return raw;
        }
    }

    return flattenComponent(raw) || null;
}

function keyOf({ x, y, z }) {
    return `${x}:${y}:${z}`;
}

function positive(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = { Core };
