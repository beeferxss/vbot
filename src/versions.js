'use strict';

// The version a player joins on. The bot cannot see it in the tab list, so
// ViaVersion is asked: `/viaver player <name>` prints the protocol numbers the
// player and the server behind the proxy speak. The answer is kept as the last
// version seen, and `alts` shows it on the name's hover.
//
// A command block keeps only the last message it printed, which is the protocol
// line, so that is what runTracked hands back. When the reply names several
// players (a list, not a single lookup), each protocol line is matched with the
// name above it so nobody else's version is shown as the player's.

const { lookupCommand } = require('./ip');

const DEFAULT_COMMAND = 'viaver player {player}';
const DEFAULT_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_GAP_MS = 1500;
const DEFAULT_RESCAN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 4000;
// ViaVersion can answer from the backend server rather than the proxy, so the
// block is read a moment later than the plain /seen lookup is.
const OUTPUT_DELAY_MS = 500;
const MAX_QUEUE = 64;

const PROTOCOL = /Client\s+protocol:\s*([^\s,;]+)\s+Server\s+protocol:\s*([^\s,;]+)(?:\s+Client:\s*([^\s,;]+))?/i;
const HEADER = /^\s*\[([A-Za-z0-9_]{1,16})\]/;

// "Client protocol: 26.3 Server protocol: 26.3 Client: false" -> the numbers.
// `name` may be omitted, and then the last block wins: that is the single-player
// answer, where only the protocol line is left.
function parseViaver(text, name) {
    const entries = [];
    let current = null;

    for (const line of String(text || '').split(/\r?\n/)) {
        const header = HEADER.exec(line);
        if (header) current = header[1];

        const match = PROTOCOL.exec(line);
        if (!match) continue;
        entries.push({
            name: current,
            client: match[1],
            server: match[2],
            viaClient: match[3] || null
        });
    }
    if (!entries.length) return null;

    const wanted = String(name || '').trim().toLowerCase();
    if (wanted) {
        const named = entries.find(entry => entry.name && entry.name.toLowerCase() === wanted);
        if (named) return named;
        // A block for somebody else must never read as this player's.
        if (entries.some(entry => entry.name)) return null;
    }
    return entries[entries.length - 1];
}

class VersionLookup {
    constructor({ bot, store, config = {}, logger }) {
        this.bot = bot;
        this.store = store;
        this.log = logger;

        this.enabled = config.enabled !== false;
        this.template = typeof config.command === 'string' ? config.command : DEFAULT_COMMAND;
        this.cacheMs = positive(config.cacheMs, DEFAULT_CACHE_MS);
        this.gapMs = positive(config.gapMs, DEFAULT_GAP_MS);
        this.rescanMs = positive(config.rescanMs, DEFAULT_RESCAN_MS);
        this.timeoutMs = positive(config.timeoutMs, DEFAULT_TIMEOUT_MS);

        this.cache = new Map();
        this.inflight = new Map();
        // Named "pending" because queue() is the method that feeds it.
        this.pending = [];
        this.queued = new Set();
        this.draining = false;
        this.timer = null;
        this.destroyed = false;
        this.rescanTimer = setInterval(() => this.rescan(), this.rescanMs);
        this.rescanTimer.unref?.();
    }

    get usable() {
        return this.enabled && Boolean(this.template);
    }

    keyFor(name) {
        return String(name || '').trim().toLowerCase();
    }

    // Synchronous: whatever is already known, so a hover never waits. The live
    // cache first, then the last version the database kept.
    versionFor(name) {
        const key = this.keyFor(name);
        if (!key) return null;

        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.at < this.cacheMs) return cached;

        const stored = typeof this.store?.getPlayer === 'function' ? this.store.getPlayer(name) : null;
        if (stored?.version) return { version: stored.version, at: stored.version_at || null };
        return null;
    }

    // Asks the server, then keeps what came back. Shared between callers so a
    // player joining during a lookup does not run the command twice.
    async lookup(name, { force = false } = {}) {
        const key = this.keyFor(name);
        if (!key || !this.usable) return null;

        const cached = this.cache.get(key);
        if (!force && cached && Date.now() - cached.at < this.cacheMs) return cached;
        if (this.inflight.has(key)) return this.inflight.get(key);

        const run = this.ask(name)
            .then(result => {
                if (!result) return null;
                this.cache.set(key, result);
                return result;
            })
            .finally(() => this.inflight.delete(key));

        this.inflight.set(key, run);
        return run;
    }

    async ask(name) {
        const command = lookupCommand(this.template, name);
        if (!command) return null;

        const core = this.bot?.core;
        if (!core || core.ready !== true || typeof core.runTracked !== 'function') {
            this.log?.debug?.(`no core for a version lookup of ${name}`);
            return null;
        }

        let output = null;
        try {
            output = await core.runTracked(command, {
                delay: OUTPUT_DELAY_MS,
                timeout: this.timeoutMs
            });
        } catch (error) {
            this.log?.warn?.(`version lookup of ${name} with "${this.template}" failed: ${error.message}`);
            return null;
        }

        const found = parseViaver(output || '', name);
        if (!found) {
            this.log?.debug?.(`version lookup of ${name} found no protocol line`);
            return null;
        }

        const result = { version: found.client, server: found.server, at: Date.now() };
        this.record(name, result);
        return result;
    }

    // The version outlives the session, so it goes into the player row.
    record(name, { version }) {
        if (!version) return;
        if (typeof this.store?.recordVersion === 'function') this.store.recordVersion(name, version);
        this.log?.info?.(`version of ${name}: ${version}`);
    }

    // Background lookup, one at a time: a join should not fire eight commands.
    queue(name, { force = false } = {}) {
        if (!this.usable || this.destroyed) return false;
        const key = this.keyFor(name);
        if (!key || this.queued.has(key) || this.pending.length >= MAX_QUEUE) return false;

        if (!force) {
            const known = this.versionFor(name);
            if (known?.at && Date.now() - known.at < this.cacheMs) return false;
        }

        this.queued.add(key);
        this.pending.push({ name, force });
        this.drain();
        return true;
    }

    // Whoever is on the tab list gets looked at again every rescanMs.
    rescan() {
        if (!this.usable || this.destroyed) return 0;
        if (this.bot?.state && this.bot.state !== 'ready') return 0;

        const online = this.bot?.online;
        if (!(online instanceof Map) || !online.size) return 0;

        let queued = 0;
        for (const player of online.values()) {
            if (player?.name && this.queue(player.name, { force: true })) queued++;
        }
        if (queued) this.log?.debug?.(`rescanned ${queued} player(s) for versions`);
        return queued;
    }

    drain() {
        if (this.draining || this.destroyed) return;
        this.draining = true;

        const next = () => {
            if (this.destroyed) {
                this.draining = false;
                return;
            }

            const job = this.pending.shift();
            if (!job) {
                this.draining = false;
                return;
            }
            const { name, force } = job;
            this.queued.delete(this.keyFor(name));

            this.lookup(name, { force })
                .catch(error => this.log?.debug?.(`queued version lookup of ${name} failed: ${error.message}`))
                .finally(() => {
                    if (this.destroyed) {
                        this.draining = false;
                        return;
                    }
                    this.timer = setTimeout(next, this.gapMs);
                    this.timer.unref?.();
                });
        };

        next();
    }

    destroy() {
        this.destroyed = true;
        this.pending.length = 0;
        this.queued.clear();
        if (this.timer) clearTimeout(this.timer);
        if (this.rescanTimer) clearInterval(this.rescanTimer);
        this.timer = null;
        this.rescanTimer = null;
        this.cache.clear();
    }
}

function positive(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = { parseViaver, VersionLookup, DEFAULT_COMMAND };
