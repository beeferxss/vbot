'use strict';

// Mail waits in the database, so a player only ever finds it by typing `/mail`.
// A join is answered here instead: one private line with the count, sent the
// way a command reply is, so the suggested command is a working button.
//
// The notice waits for the world and the core, because a tellraw needs the core
// command block like every other command; if the player leaves before it goes
// out there is nothing to say.

const tellraw = require('./minecraft/tellraw');

const DEFAULT_DELAY_MS = 4000;
const DEFAULT_RETRY_MS = 2500;
const DEFAULT_ATTEMPTS = 16;

class MailNotice {
    constructor({ bot, store, registry = null, config = {}, logger = null }) {
        this.bot = bot;
        this.store = store;
        this.registry = registry || bot?.registry || null;
        this.config = config;
        this.log = logger;
        this.delayMs = positive(config.delayMs, DEFAULT_DELAY_MS);
        this.retryMs = positive(config.retryMs, DEFAULT_RETRY_MS);
        this.attempts = positive(config.attempts, DEFAULT_ATTEMPTS);
        // Lower-case name -> the notice still waiting to go out for this join.
        this.pending = new Map();
    }

    get enabled() {
        return this.config.notifyOnJoin !== false;
    }

    // The prefix the player would type: the longest one the bot listens for,
    // the same rule the command matcher uses.
    get prefix() {
        const prefixes = this.bot?.config?.bot?.prefixes;
        const usable = Array.isArray(prefixes)
            ? prefixes.filter(prefix => typeof prefix === 'string' && prefix)
            : [];
        if (!usable.length) return '/';
        return usable.reduce((best, prefix) => (prefix.length > best.length ? prefix : best));
    }

    // A player has just appeared who was not online when the tab list was read.
    note(name) {
        if (!this.enabled) return false;
        const key = String(name || '').toLowerCase();
        if (!key || !this.store || typeof this.store.unreadMailCount !== 'function') return false;
        if (this.pending.has(key)) return false;

        const entry = { name, timer: null, attempts: 0 };
        this.pending.set(key, entry);
        this.arm(entry, this.delayMs);
        return true;
    }

    arm(entry, delay) {
        entry.timer = setTimeout(() => {
            entry.timer = null;
            this.attempt(entry);
        }, delay);
        entry.timer.unref?.();
    }

    attempt(entry) {
        const key = String(entry.name).toLowerCase();
        if (this.pending.get(key) !== entry) return;

        // Only a player who is still here is worth telling: a notice that
        // missed the join is not worth carrying into the next session.
        if (!this.bot || this.bot.destroyed || this.bot.state !== 'ready') {
            this.pending.delete(key);
            return;
        }
        if (this.bot.online && !this.bot.online.has(key)) {
            this.pending.delete(key);
            return;
        }

        const unread = this.store.unreadMailCount(entry.name);
        if (!unread) {
            this.pending.delete(key);
            return;
        }

        if (this.send(entry.name, unread)) {
            this.pending.delete(key);
            this.log?.debug?.(`told ${entry.name} about ${unread} unread message(s)`);
            return;
        }

        // The core is not up yet (or the reply was refused): try again while
        // they are still online.
        entry.attempts += 1;
        if (entry.attempts >= this.attempts) {
            this.pending.delete(key);
            this.log?.debug?.(`could not tell ${entry.name} about their mail`);
            return;
        }
        this.arm(entry, this.retryMs);
    }

    // The same private, clickable line a command reply is: text only says how
    // many are waiting, and the command is the next thing to click.
    send(name, unread) {
        const count = unread === 1 ? '1 unread message' : `${unread} unread messages`;
        const text = `You have ${count}. ${this.prefix}mail read to see them.`;

        if (this.registry && typeof this.registry.reply === 'function') {
            return this.registry.reply(this.bot, name, text, 'mail') !== false;
        }

        const version = this.bot?.client?.version || null;
        return this.bot.chat(tellraw.command(name, { text }, version)) !== false;
    }

    destroy() {
        for (const entry of this.pending.values()) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = null;
        }
        this.pending.clear();
    }
}

function positive(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

module.exports = { MailNotice };
