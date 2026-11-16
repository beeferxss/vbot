'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MIN_INTERVAL_MS = 100;
const MAX_COMMAND = 32000;

// Persistent per-server command loops: `cloop add 5000 say hi` keeps running
// that command through the core every interval until it is removed. Loops are
// stored on disk, so they come back after a restart or a reconnect.
class Cloops {
    constructor({ bot, storePath, logger, config = {} }) {
        this.bot = bot;
        this.storePath = storePath;
        this.log = logger;
        this.enabled = config.enabled !== false;
        this.minIntervalMs = Math.max(50, Number(config.minIntervalMs) || DEFAULT_MIN_INTERVAL_MS);
        this.timers = new Map();
    }

    loadAll() {
        try {
            if (!fs.existsSync(this.storePath)) return {};
            const raw = fs.readFileSync(this.storePath, 'utf8');
            if (!raw.trim()) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            this.log?.warn(`cloops: could not read ${this.storePath} (${error.message})`);
            return {};
        }
    }

    saveAll(all) {
        fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
        fs.writeFileSync(this.storePath, `${JSON.stringify(all, null, 4)}\n`, 'utf8');
    }

    // One list per server id, so the same file works for every bot.
    list() {
        const all = this.loadAll();
        const list = Array.isArray(all[this.bot.id]) ? all[this.bot.id] : [];
        return list
            .filter(item => item && Number.isFinite(Number(item.interval)) && typeof item.command === 'string')
            .map(item => ({
                id: Number(item.id),
                interval: Number(item.interval),
                command: String(item.command)
            }));
    }

    update(fn) {
        const all = this.loadAll();
        if (!Array.isArray(all[this.bot.id])) all[this.bot.id] = [];
        fn(all[this.bot.id]);
        this.saveAll(all);
    }

    add(interval, command) {
        if (!this.enabled) return null;
        const ms = Math.floor(Number(interval));
        if (!Number.isFinite(ms) || ms < this.minIntervalMs) return null;
        const text = String(command || '').replace(/^\//, '').trim().slice(0, MAX_COMMAND);
        if (!text) return null;

        let entry = null;
        this.update(list => {
            const id = list.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
            entry = { id, interval: ms, command: text };
            list.push(entry);
        });
        if (entry) this.restart();
        return entry;
    }

    remove(id) {
        const wanted = Number(id);
        let removed = null;
        this.update(list => {
            const index = list.findIndex(item => Number(item.id) === wanted);
            if (index !== -1) removed = list.splice(index, 1)[0];
        });
        if (removed) this.restart();
        return removed;
    }

    clear() {
        const had = this.list().length;
        this.update(list => { list.length = 0; });
        this.restart();
        return had;
    }

    schedule(item) {
        const timer = setInterval(() => {
            if (this.bot.destroyed) return;
            const core = this.bot.core;
            if (!core || typeof core.run !== 'function') return;
            core.run(item.command);
        }, item.interval);
        timer.unref?.();
        this.timers.set(item.id, timer);
    }

    start() {
        if (!this.enabled) return false;
        this.stop();
        for (const item of this.list()) this.schedule(item);
        return this.timers.size > 0;
    }

    restart() {
        this.start();
    }

    stop() {
        for (const timer of this.timers.values()) clearInterval(timer);
        this.timers.clear();
    }

    destroy() {
        this.stop();
    }
}

module.exports = { Cloops, DEFAULT_MIN_INTERVAL_MS };
