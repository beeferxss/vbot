'use strict';

const { FillItem } = require('./fillitem');

const REFILL_SETTLE_MS = 250;
const REFILL_GRACE_MS = 3000;
const REFILL_MIN_INTERVAL_MS = 1500;
const WATCHDOG_MS = 1000;
const OWN_CHANGE_MS = 6000;
const DAMAGE_COALESCE_MS = 250;
const MAX_BACKOFF_MS = 10000;

class Core {
    constructor({ bot, config, logger }) {
        this.bot = bot;
        this.config = config || {};
        this.log = logger;

        this.enabled = this.config.enabled !== false;
        this.refillEnabled = this.config.refill?.enabled !== false;
        this.itemRefills = this.config.refill?.item !== false;
        this.intervalMs = positive(this.config.refill?.intervalMs, 1000);
        this.spamMs = positive(this.config.refill?.spamMs, 150);

        this.size = positive(this.config.area?.size, 9);
        this.y = Number.isFinite(Number(this.config.area?.y)) ? Number(this.config.area.y) : 64;
        this.block = String(this.config.refill?.block || 'minecraft:repeating_command_block');

        this.fillItem = new FillItem({ bot, logger, config: this.config.refill });

        this.origin = { x: null, y: this.y, z: null };
        this.bounds = { x: null, y: this.y, z: null };
        this.blocks = new Map(); // key -> { alive: boolean, verifiedAt: number }
        this.cursor = 0;
        this.ready = false;
        this.everReady = false;

        this.refilling = false;
        this.refillReason = null;
        this.lastRefillAt = 0;
        this.graceUntil = 0;
        this.lastFill = null;
        this.fillFailures = 0;
        this.itemFills = 0;
        this.lastLocation = null;
        this._lastRunOk = true;

        this.ownChanges = new Map(); // key -> expiry
        this.damageTimer = null;
        this.watchdog = null;
        this.retryTimer = null;
        this.retryBackoff = 0;

        this.spam = null;
        this.spamTimer = null;

        this.queries = new Map();
        this.nextQueryId = 1;

        this.logThrottle = new Map();

        this.client = null;
    }

    onReady() {
        this.startWatchdog();
        if (!this.origin.x && this.bot.position) this.reset(this.bot.position);
        if (this.origin.x !== null && this.refillEnabled) this.refill('startup', { force: true });
        if (this.refillEnabled && this.config.refill?.auto) {
            this.startSpam({ intervalMs: this.spamMs });
        }
    }

    bindClient(client) {
        this.client = client || this.bot.client || null;
    }

    startWatchdog() {
        if (this.watchdog) return;
        this.watchdog = setInterval(() => this.watchdogTick(), WATCHDOG_MS);
        this.watchdog.unref?.();
    }

    watchdogTick() {
        if (!this.enabled || !this.refillEnabled || this.bot.destroyed) return;
        if (this.origin.x === null) {
            if (this.bot.position) this.reset(this.bot.position);
            return;
        }
        if (this.refilling) return;
        if (this.spam && this.spam.running) return;

        const alive = this.aliveCount();
        const total = this.blocks.size;
        if (total === 0 || alive === 0) {
            this.ready = false;
            this.refill('watchdog-empty', { force: true });
            return;
        }
        if (!this.ready) {
            this.refill('watchdog-not-ready', { force: alive === 0 });
        }
    }

    aliveCount() {
        let n = 0;
        for (const b of this.blocks.values()) if (b && b.alive) n++;
        return n;
    }

    totalCells() {
        return this.size * this.size * this.size;
    }

    allCells() {
        if (this.origin.x === null) return [];
        const out = [];
        for (let y = 0; y < this.size; y++) {
            for (let z = 0; z < this.size; z++) {
                for (let x = 0; x < this.size; x++) {
                    out.push({
                        x: this.origin.x + x,
                        y: this.origin.y + y,
                        z: this.origin.z + z
                    });
                }
            }
        }
        return out;
    }

    reset(position = this.bot.position) {
        if (!this.enabled) return false;
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return false;
        this.origin = {
            x: Math.floor(position.x) - Math.floor(this.size / 2),
            y: this.y,
            z: Math.floor(position.z) - Math.floor(this.size / 2)
        };
        this.bounds = {
            x: this.origin.x + this.size - 1,
            y: this.origin.y + this.size - 1,
            z: this.origin.z + this.size - 1
        };
        this.blocks.clear();
        for (const cell of this.allCells()) this.blocks.set(keyOf(cell), { alive: false, verifiedAt: 0 });
        this.cursor = 0;
        this.ready = false;
        this.refilling = false;
        this.graceUntil = 0;
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        this.retryBackoff = 0;
        return true;
    }

    inside({ x, y, z }) {
        if (this.origin.x === null) return false;
        return x >= this.origin.x && x <= this.bounds.x &&
            y >= this.origin.y && y <= this.bounds.y &&
            z >= this.origin.z && z <= this.bounds.z;
    }

    markOwn(location) {
        if (!location) return;
        this.ownChanges.set(keyOf(location), Date.now() + OWN_CHANGE_MS);
    }

    isOwn(location) {
        if (!location) return false;
        const k = keyOf(location);
        const until = this.ownChanges.get(k);
        if (!until) return false;
        if (until < Date.now()) {
            this.ownChanges.delete(k);
            return false;
        }
        return true;
    }

    setBlockAlive(location, alive) {
        const k = keyOf(location);
        if (!this.blocks.has(k)) return;
        const prev = this.blocks.get(k) || { alive: false, verifiedAt: 0 };
        this.blocks.set(k, { alive: !!alive, verifiedAt: alive ? Date.now() : (prev.verifiedAt || 0) });
    }

    markAllAlive() {
        for (const [k, b] of this.blocks.entries()) {
            this.blocks.set(k, { alive: true, verifiedAt: Date.now() });
        }
        this.ready = this.blocks.size > 0;
        if (this.ready) this.everReady = true;
    }

    blockSpec() {
        const block = this.block || 'minecraft:repeating_command_block';
        const name = this.config.name;
        if (!name) return block;
        const parsed = parseCustomName(name);
        if (!parsed) return block;
        const version = this.bot.client?.version || '1.21.4';
        if (usesSnbt(version)) {
            return `${block}{CustomName:${toSnbt(parsed)}}`;
        }
        return `${block}{CustomName:'${JSON.stringify(parsed).replace(/'/g, "\\'")}'}`;
    }

    fillCommand() {
        if (this.origin.x === null) return null;
        const block = this.blockSpec();
        return `fill ${this.origin.x} ${this.origin.y} ${this.origin.z} ${this.bounds.x} ${this.bounds.y} ${this.bounds.z} ${block} replace`;
    }

    refill(reason = 'manual', options = {}) {
        if (!this.enabled || !this.refillEnabled) return false;
        if (this.origin.x === null) {
            if (this.bot.position) this.reset(this.bot.position);
            if (this.origin.x === null) return false;
        }
        const now = Date.now();
        if (this.refilling) return false;
        if (!options.force && now - this.lastRefillAt < REFILL_MIN_INTERVAL_MS) return false;

        this.lastRefillAt = now;
        this.refilling = true;
        this.refillReason = reason;
        this.ready = false;
        this.graceUntil = now + REFILL_GRACE_MS;

        const command = this.fillCommand();
        if (!command) {
            this.refilling = false;
            return false;
        }

        let sent = false;
        const viaChat = options.viaChat === true;

        // 1) Try surviving core block for automatic refills (like example survivor refill)
        if (!viaChat && this.everReady) {
            const survivors = this.survivors();
            if (survivors.length > 0) {
                // try a few survivors
                for (let i = 0; i < Math.min(survivors.length, 5); i++) {
                    const cell = survivors[(Math.floor(Math.random() * survivors.length)) % survivors.length];
                    if (this.writeCommandToCell(cell, command)) {
                        sent = true;
                        break;
                    }
                }
            }
        }

        // 2) Try placing a command block item (chat-free refill path in vbot)
        if (!sent && !viaChat && this.itemRefills && this.fillItem?.usable) {
            sent = this.fillItem.run(command, 2) === true; // mode 2 impulse for placed block write is fine; command is fill
            if (sent) this.itemFills++;
        }

        // 3) Chat fallback (or explicit command)
        if (!sent) {
            sent = this.sendChat(command);
        }

        if (!sent) {
            this.refilling = false;
            this.scheduleRetry(reason);
            return false;
        }

        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        this.retryBackoff = 0;

        // settle: assume filled; real confirmation can come from noteMessage but don't depend on it
        setTimeout(() => {
            if (!this.enabled) return;
            if (this.origin.x === null) return;
            // mark all cells present/alive after refill settle
            for (const cell of this.allCells()) this.setBlockAlive(cell, true);
            this.refilling = false;
            this.ready = this.aliveCount() > 0;
            if (this.ready) this.everReady = true;
        }, REFILL_SETTLE_MS).unref?.();

        return true;
    }

    scheduleRetry(reason) {
        if (this.retryTimer) return;
        this.retryBackoff = Math.min(this.retryBackoff ? this.retryBackoff * 2 : 1000, MAX_BACKOFF_MS);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.enabled || !this.refillEnabled || this.bot.destroyed) return;
            this.refill(`retry:${reason || 'unknown'}`, { force: this.aliveCount() === 0 });
        }, this.retryBackoff);
        this.retryTimer.unref?.();
    }

    sendChat(command) {
        if (typeof this.bot.sendChat === 'function') return this.bot.sendChat(command) !== false;
        if (typeof this.bot.chat === 'function') return this.bot.chat('/' + String(command).replace(/^\//, '')) !== false;
        return false;
    }

    survivors() {
        const out = [];
        for (const [k, b] of this.blocks.entries()) {
            if (b && b.alive) {
                const [x, y, z] = k.split(':').map(Number);
                if (Number.isFinite(x)) out.push({ x, y, z });
            }
        }
        return out;
    }

    survivor() {
        const s = this.survivors();
        return s.length ? s[0] : null;
    }

    writeCommandToCell(cell, command) {
        if (!cell || !command) return false;
        if (!this.bot.write) return false;
        const loc = { x: cell.x, y: cell.y, z: cell.z };
        this.markOwn(loc);
        const mode = this.blockMode();
        try {
            const sent = this.bot.write('update_command_block', {
                location: loc,
                command: String(command).replace(/^\//, ''),
                mode,
                flags: 0b101
            });
            if (sent === false) {
                this.ownChanges.delete(keyOf(loc));
                return false;
            }
            this.lastLocation = loc;
            this.setBlockAlive(loc, true);
            return true;
        } catch {
            this.ownChanges.delete(keyOf(loc));
            return false;
        }
    }

    blockMode() {
        const b = String(this.block || '').toLowerCase();
        if (b.includes('repeating_command_block')) return 1;
        if (b.includes('chain_command_block')) return 0;
        return 2;
    }

    nextAliveCell() {
        if (this.blocks.size === 0) return null;
        const cells = this.allCells();
        if (!cells.length) return null;
        const total = cells.length;
        for (let i = 0; i < total; i++) {
            const idx = (this.cursor + i) % total;
            const cell = cells[idx];
            const b = this.blocks.get(keyOf(cell));
            if (b && b.alive) {
                this.cursor = (idx + 1) % total;
                return cell;
            }
        }
        return null;
    }

    run(text) {
        if (!this.enabled) { this._lastRunOk = false; return null; }
        if (this.origin.x === null) {
            if (this.bot.position) this.reset(this.bot.position);
            if (this.origin.x === null) { this._lastRunOk = false; return null; }
        }

        // if we were never truly ready and have no tracked blocks, ensure map exists
        if (this.blocks.size === 0) {
            for (const cell of this.allCells()) this.blocks.set(keyOf(cell), { alive: !!this.ready, verifiedAt: 0 });
        }

        let cell = this.nextAliveCell();
        if (!cell) {
            // recovery: if ever ready or all dead, try to resurrect block tracking and refill
            if (this.everReady || this.aliveCount() === 0) {
                for (const c of this.allCells()) this.setBlockAlive(c, true);
                this.ready = true;
                cell = this.nextAliveCell();
            }
        }
        if (!cell) {
            this._lastRunOk = false;
            this.ready = false;
            this.refill('no-blocks', { force: true });
            return null;
        }

        const command = String(text || '').replace(/^\//, '').trim();
        const ok = this.writeCommandToCell(cell, command);
        if (!ok) {
            this.setBlockAlive(cell, false);
            this._lastRunOk = false;
            if (this.aliveCount() === 0) this.refill('run-failed-all-dead', { force: true });
            return null;
        }

        this._lastRunOk = true;
        this.ready = true;
        this.everReady = true;
        return cell;
    }

    runTracked(text, opts = {}) {
        const delay = positive(opts.delay, 100);
        const timeout = positive(opts.timeout, 2500);
        const cell = this.run(text);
        if (!cell) return Promise.resolve(null);

        // bind client if needed
        if (!this.client) this.client = this.bot.client || null;
        if (!this.client || typeof this.bot.write !== 'function') return Promise.resolve(null);

        const id = this.nextQueryId++;
        return new Promise(resolve => {
            const finish = (value) => {
                const pending = this.queries.get(id);
                if (!pending) return;
                clearTimeout(pending.timer);
                this.queries.delete(id);
                resolve(value);
            };
            const timer = setTimeout(() => finish(null), timeout);
            timer.unref?.();
            this.queries.set(id, { timer, resolve: finish, location: cell });
            setTimeout(() => {
                if (!this.queries.has(id)) return;
                try {
                    this.bot.write('query_block_nbt', { transactionId: id, location: cell });
                } catch {
                    finish(null);
                }
            }, delay).unref?.();
        });
    }

    noteMessage(line) {
        if (typeof line !== 'string' || !line) return false;
        // Look for fill success/failure indicators (server can report as translate key or plain text)
        const m = line.match(/commands\.fill\.success(\d+)/) || line.match(/Successfully filled (\d+) blocks?/i);
        if (m) {
            const blocks = Number(m[1]);
            this.lastFill = { ok: true, blocks, at: Date.now(), line };
            this.fillFailures = 0;
            if (this.blocks.size === 0 && this.origin.x !== null) {
                for (const cell of this.allCells()) this.setBlockAlive(cell, true);
            }
            if (blocks > 0 || this.aliveCount() > 0) {
                this.ready = true;
                this.everReady = true;
            }
            if (blocks > 0) this.markAllAlive();
            return true;
        }
        if (/commands\.fill\.failed|Could not fill|No blocks filled|could not place/i.test(line)) {
            const hasAlive = this.aliveCount() > 0;
            this.lastFill = { ok: hasAlive, blocks: 0, at: Date.now(), line };
            if (hasAlive) {
                this.ready = true;
                this.everReady = true;
                this.fillFailures = 0;
            } else {
                this.fillFailures++;
                this.ready = false;
            }
            return true;
        }
        return false;
    }

    noteRegistry() {}
    noteSlot() {}

    onBlockChange(packet) {
        if (!packet || this.origin.x === null) return false;
        const location = packet.location || packet.position || packet;
        if (!location || !Number.isFinite(Number(location.x))) return false;
        const loc = { x: Number(location.x), y: Number(location.y), z: Number(location.z) };
        if (!this.inside(loc)) return false;

        if (this.isOwn(loc)) return false;

        // During refill/grace, ignore non-own updates except hard break handling below is suppressed to avoid thrash
        const inGrace = this.refilling || Date.now() < this.graceUntil;

        if (isAir(packet)) {
            // block broken
            this.setBlockAlive(loc, false);
            this.ready = this.aliveCount() > 0;
            if (!inGrace) this.refill('broken', { force: this.aliveCount() === 0 });
            return true;
        }

        if (inGrace) return false;

        // External change to a core block: treat as damage, coalesce refill
        this.setBlockAlive(loc, false);
        this.ready = this.aliveCount() > 0;
        if (this.damageTimer) return true;
        this.damageTimer = setTimeout(() => {
            this.damageTimer = null;
            if (!this.enabled || !this.refillEnabled || this.bot.destroyed) return;
            this.refill(this.aliveCount() > 0 ? 'damaged' : 'empty', { force: this.aliveCount() === 0 });
        }, DAMAGE_COALESCE_MS);
        this.damageTimer.unref?.();
        return true;
    }

    handleNbtQueryResponse(packet) {
        if (!packet) return;
        const id = packet.transactionId ?? packet.id;
        if (!this.queries.has(id)) return;
        const nbt = packet.nbt ?? packet.tag ?? packet.data;
        const output = parseLastOutput(nbt);
        const pending = this.queries.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.queries.delete(id);
        pending.resolve(output);
    }

    // Spam refill: repeatedly writes the fill command into core blocks (not chat)
    startSpam({ durationMs, intervalMs } = {}) {
        if (this.spam && this.spam.running) return false;
        if (!this.enabled || !this.refillEnabled) return false;
        if (this.origin.x === null) {
            if (this.bot.position) this.reset(this.bot.position);
            if (this.origin.x === null) return false;
        }
        const interval = positive(intervalMs, this.spamMs);
        const now = Date.now();
        this.spam = {
            running: true,
            intervalMs: interval,
            count: 0,
            startedAt: now,
            endsAt: Number.isFinite(durationMs) ? now + durationMs : null
        };
        if (this.spamTimer) clearInterval(this.spamTimer);
        this.spamTimer = setInterval(() => this.spamTick(), interval);
        this.spamTimer.unref?.();
        this.spamTick();
        return true;
    }

    spamTick() {
        const spam = this.spam;
        if (!spam || !spam.running) return;
        if (spam.endsAt && Date.now() >= spam.endsAt) {
            this.stopSpam('finished');
            return;
        }
        const cmd = this.fillCommand();
        if (!cmd) return;
        // write through a block if possible, else try chat-free? tests expect block writes only
        const cell = this.nextAliveCell() || this.survivor() || (this.blocks.size ? coordFromKey([...this.blocks.keys()][this.cursor % this.blocks.size]) : null);
        if (cell) {
            const ok = this.writeCommandToCell(cell, cmd);
            if (ok) spam.count++;
            return;
        }
        // if no known block, try sending via item refill as block-backed write path? no, tests assert writes are update_command_block fills.
        // fallback: mark all alive and try once
        for (const c of this.allCells()) this.setBlockAlive(c, true);
        const c2 = this.nextAliveCell();
        if (c2 && this.writeCommandToCell(c2, cmd)) spam.count++;
    }

    stopSpam(_reason) {
        if (!this.spam || !this.spam.running) return false;
        this.spam.running = false;
        if (this.spamTimer) {
            clearInterval(this.spamTimer);
            this.spamTimer = null;
        }
        return true;
    }

    spamStatus() {
        if (!this.spam || !this.spam.running) return { running: false, intervalMs: this.spamMs };
        const leftMs = this.spam.endsAt ? Math.max(0, this.spam.endsAt - Date.now()) : null;
        return {
            running: true,
            intervalMs: this.spam.intervalMs,
            count: this.spam.count,
            leftMs
        };
    }

    status() {
        const name = this.config.name || '(unnamed)';
        const pos = this.origin.x === null ? 'not placed' : `${this.origin.x},${this.origin.y},${this.origin.z}`;
        return `core ${this.ready ? 'ready' : 'not ready'} at ${pos} | alive ${this.aliveCount()}/${this.blocks.size || this.totalCells()} | name ${name}`;
    }

    statusParts() {
        const parts = [];
        parts.push({ text: `core ${this.ready ? 'ready' : 'not ready'}`, color: this.ready ? 'green' : 'red' });
        if (this.origin.x !== null) {
            parts.push({ text: ` at ${this.origin.x},${this.origin.y},${this.origin.z}`, color: 'gray' });
        } else {
            parts.push({ text: ' (not placed)', color: 'gray' });
        }
        parts.push({ text: ` | alive ${this.aliveCount()}/${this.blocks.size || this.totalCells()}`, color: 'gray' });
        const name = parseCustomName(this.config.name);
        if (name) {
            parts.push({ text: ' | name ', color: 'gray' });
            if (name.text) parts.push({ text: String(name.text), color: name.color || 'white' });
            else parts.push({ text: JSON.stringify(name), color: 'gray' });
        }
        return parts;
    }

    logEvery(key, level, ms, message) {
        const now = Date.now();
        const last = this.logThrottle.get(key) || 0;
        if (now - last < ms) return;
        this.logThrottle.set(key, now);
        this.log?.[level]?.(message);
    }

    destroy() {
        this.enabled = false;
        if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        if (this.damageTimer) { clearTimeout(this.damageTimer); this.damageTimer = null; }
        if (this.spamTimer) { clearInterval(this.spamTimer); this.spamTimer = null; }
        for (const q of this.queries.values()) clearTimeout(q.timer);
        this.queries.clear();
        this.fillItem?.destroy?.();
        this.client = null;
    }
}

function keyOf({ x, y, z }) {
    return `${x}:${y}:${z}`;
}

function coordFromKey(k) {
    const [x, y, z] = String(k).split(':').map(Number);
    return { x, y, z };
}

function isAir(packet) {
    const state = packet?.type ?? packet?.state ?? packet?.blockId;
    if (state === 0 || state === 'minecraft:air' || state === 'air') return true;
    const name = packet?.name ?? packet?.block;
    return name === 'minecraft:air' || name === 'air';
}

function positive(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseCustomName(name) {
    if (!name) return null;
    if (typeof name === 'object') return name;
    const str = String(name);
    try { return JSON.parse(str); } catch { return { text: str }; }
}

function usesSnbt(version) {
    // 1.21.5+ expects component-style/SNBT in many command contexts; match vbot's prior behavior heuristic
    if (!version) return false;
    const m = String(version).match(/^1\.(\d+)(?:\.(\d+))?/);
    if (!m) return true; // modern/snapshot-ish strings -> snbt
    const minor = Number(m[1]);
    const patch = Number(m[2] || 0);
    if (minor > 21) return true;
    if (minor === 21 && patch >= 5) return true;
    return false;
}

function toSnbt(value) {
    if (value === null || value === undefined) return '""';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (Array.isArray(value)) return `[${value.map(toSnbt).join(',')}]`;
    if (typeof value === 'object') {
        return `{${Object.entries(value).map(([k, v]) => `${safeKey(k)}:${toSnbt(v)}`).join(',')}}`;
    }
    return `'${String(value)}'`;
}

function safeKey(k) {
    return /^[A-Za-z0-9_.+-]+$/.test(k) ? k : `'${String(k).replace(/'/g, "\\'")}'`;
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
    if (component[''] !== undefined) out += flattenComponent(component['']);
    if (component.extra) out += flattenComponent(component.extra);
    return out;
}

function parseLastOutput(nbt) {
    const found = findKey(nbt, 'LastOutput');
    if (found === undefined) return null;
    let raw = simplifyNbt(found);
    if (typeof raw === 'string') {
        if (!raw) return null;
        try { raw = JSON.parse(raw); } catch { return raw; }
    }
    return flattenComponent(raw) || null;
}

module.exports = { Core };
