'use strict';

// Looked-up IPs, cached.
//
// The bot cannot see where a player connects from, so the only source is a
// server command that prints it. Addresses come from the lookup command only,
// which is /seen by default because every server has it. That command is run
// through a core block with runTracked, its output is parsed, and the addresses
// are stored so /alts and /list keep working after the fact.
//
// whois is kept for the one place that needs it: the identity command shows the
// fields it prints (uuid, gamemode, money...) that /seen does not.

const { parseIps, parseUuid, parseWhois, lookupCommand } = require('./ip');

const DEFAULT_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_GAP_MS = 1200;
const DEFAULT_RESCAN_MS = 60 * 1000;
const MAX_QUEUE = 64;

class IpLookup {
    constructor({ bot, store, config = {}, logger }) {
        this.bot = bot;
        this.store = store;
        this.log = logger;

        this.enabled = config.enabled !== false;
        // Off by default: an unknown command costs a core round trip per player.
        // This is the only command that ever gives back an address.
        this.template = typeof config.lookupCommand === 'string' ? config.lookupCommand : '';
        // Used only when the lookup command gives back no address.
        this.fallback = typeof config.fallbackCommand === 'string' ? config.fallbackCommand : '';
        // Read by the identity command alone, for its extra fields.
        this.detailTemplate = typeof config.detailCommand === 'string' ? config.detailCommand : '';
        this.cacheMs = positive(config.cacheMs, DEFAULT_CACHE_MS);
        this.gapMs = positive(config.gapMs, DEFAULT_GAP_MS);
        this.timeoutMs = positive(config.timeoutMs, 3000);
        // Everything online is re-checked on this interval, so an address that
        // changes is picked up without anyone asking.
        this.rescanMs = positive(config.rescanMs, DEFAULT_RESCAN_MS);

        this.cache = new Map();
        this.detailsCache = new Map();
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

    // Synchronous: whatever is already known, so a hover never waits.
    ipFor(name) {
        const key = this.keyFor(name);
        if (!key) return null;

        const cached = this.cache.get(key);
        if (cached && cached.ips.length && Date.now() - cached.at < this.cacheMs) return cached.ips[0];

        const stored = this.store.ipsFor(name);
        return stored.length ? stored[0].ip : null;
    }

    historyFor(name) {
        return this.store.ipsFor(name);
    }

    // Asks the server, then stores what came back. Shared between callers so a
    // player joining during a lookup does not run the command twice.
    async lookup(name, { force = false } = {}) {
        const key = this.keyFor(name);
        if (!key || !this.usable) return [];

        const cached = this.cache.get(key);
        if (!force && cached && Date.now() - cached.at < this.cacheMs) return cached.ips;
        if (this.inflight.has(key)) return this.inflight.get(key);

        const run = this.ask(name)
            .then(ips => {
                this.cache.set(key, { ips, at: Date.now() });
                return ips;
            })
            .finally(() => this.inflight.delete(key));

        this.inflight.set(key, run);
        return run;
    }

    async runLookup(template, name) {
        const command = lookupCommand(template, name);
        if (!command) return null;

        const core = this.bot.core;
        if (!core || core.ready !== true || typeof core.runTracked !== 'function') {
            this.log.debug(`no core for a lookup of ${name}`);
            return null;
        }

        try {
            return await core.runTracked(command, { delay: 250, timeout: this.timeoutMs });
        } catch (error) {
            this.log.warn(`lookup of ${name} with "${template}" failed: ${error.message}`);
            return null;
        }
    }

    // Asks the lookup command, falls back to the other one when it gives back no
    // address, and parses whatever fields came with it.
    async query(name) {
        let source = this.template;
        let output = await this.runLookup(this.template, name);
        let ips = parseIps(output || '');

        if (!ips.length && this.fallback && this.fallback !== this.template) {
            const alternative = await this.runLookup(this.fallback, name);
            if (alternative) {
                const altIps = parseIps(alternative);
                if (altIps.length || !output) {
                    source = this.fallback;
                    output = alternative;
                    ips = altIps;
                }
            }
        }

        const fields = parseWhois(output || '');
        // The whois parser normalises the address, so it is authoritative.
        if (fields.ip && !ips.includes(fields.ip)) ips.push(fields.ip);

        const result = { output, ips, fields, source, at: Date.now() };
        this.record(name, result);
        return result;
    }

    // The uuid and the addresses a reply carries are worth keeping.
    record(name, { ips, fields }) {
        const uuid = fields.uuid || parseUuid('');
        if (uuid && typeof this.store.getPlayer === 'function' && !this.store.getPlayer(name)?.uuid) {
            this.store.linkPlayer(name, uuid);
        }

        if (!ips.length) return;
        const knownUuid = uuid ?? (typeof this.bot.uuidFor === 'function' ? this.bot.uuidFor(name) : null);
        for (const ip of ips) this.store.recordIp(name, ip, knownUuid);
        this.log.info(`ip lookup of ${name}: ${ips.join(', ')}`);
    }

    async ask(name) {
        const { ips } = await this.query(name);
        if (!ips.length) this.log.debug(`lookup of ${name} found no address`);
        return ips;
    }

    // The fields a command wants to show, from the detail command. No address is
    // taken from here: whois is not a lookup source any more, only a field list.
    async details(name) {
        const key = this.keyFor(name);
        if (!key) return { output: null, ips: [], fields: {}, source: '', at: Date.now() };

        const cached = this.detailsCache.get(key);
        if (cached && Date.now() - cached.at < this.cacheMs) return cached;

        const template = this.detailTemplate || this.template;
        const output = this.enabled && template ? await this.runLookup(template, name) : null;
        const fields = parseWhois(output || '');
        // The uuid is worth keeping; an address from here is not, /seen is.
        this.record(name, { ips: [], fields });

        const result = { output, ips: [], fields, source: template, at: Date.now() };
        this.detailsCache.set(key, result);
        return result;
    }

    // Background lookup, one at a time: a join should not fire eight commands.
    queue(name, { force = false } = {}) {
        if (!this.usable || this.destroyed) return false;
        const key = this.keyFor(name);
        if (!key || this.queued.has(key) || this.pending.length >= MAX_QUEUE) return false;

        if (!force) {
            const cached = this.cache.get(key);
            if (cached && Date.now() - cached.at < this.cacheMs) return false;
            if (!cached && this.store.ipsFor(name).length) return false;
        }

        this.queued.add(key);
        this.pending.push({ name, force });
        this.drain();
        return true;
    }

    // Whoever is on the tab list gets looked up again every rescanMs.
    rescan() {
        if (!this.usable || this.destroyed) return 0;
        if (this.bot?.state && this.bot.state !== 'ready') return 0;

        const online = this.bot?.online;
        if (!(online instanceof Map) || !online.size) return 0;

        let queued = 0;
        for (const player of online.values()) {
            if (player?.name && this.queue(player.name, { force: true })) queued++;
        }
        if (queued) this.log.debug(`rescanned ${queued} player(s) for addresses`);
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
                .catch(error => this.log.debug(`queued ip lookup of ${name} failed: ${error.message}`))
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
        this.detailsCache.clear();
    }
}

function positive(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = { IpLookup };
