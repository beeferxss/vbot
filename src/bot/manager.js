'use strict';

const EventEmitter = require('node:events');
const { Bot } = require('./bot');

class BotManager extends EventEmitter {
    constructor({ config, store, permissions, registry, logger }) {
        super();
        this.config = config;
        this.store = store;
        this.permissions = permissions;
        this.registry = registry;
        this.logger = logger;
        this.bots = new Map();
    }

    create(server) {
        if (!server?.id) throw new Error('server id is required');
        if (this.bots.has(server.id)) throw new Error(`bot "${server.id}" already exists`);

        const bot = new Bot({
            server,
            config: this.config,
            store: this.store,
            permissions: this.permissions,
            registry: this.registry,
            logger: this.logger
        });

        for (const event of ['ready', 'disconnect', 'failed', 'chat']) {
            bot.on(event, (...args) => this.emit(event, bot, ...args));
        }

        this.bots.set(server.id, bot);
        this.emit('created', bot);
        return bot;
    }

    // Starts every enabled server, staggered so a restart does not flood the
    // servers or the network with simultaneous logins.
    async startAll(delayMs = 500) {
        const servers = this.config.minecraft.servers.filter(server => server.enabled);
        const started = [];

        for (const server of servers) {
            try {
                const bot = this.create(server);
                bot.start();
                started.push(bot);
                this.logger.info(`started ${server.id}`);
            } catch (error) {
                this.logger.error(`could not start ${server.id}: ${error.message}`);
                continue;
            }
            if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        if (!started.length) this.logger.warn('no enabled servers in config.json');
        return started;
    }

    get(id) {
        return this.bots.get(String(id)) || null;
    }

    list() {
        return [...this.bots.values()];
    }

    async restart(id) {
        const bot = this.get(id);
        if (!bot) return false;
        bot.stop('restarting');
        bot.destroyed = false;
        bot.attempts = 0;
        bot.start();
        return true;
    }

    async stopAll() {
        for (const bot of this.list()) {
            try { bot.stop(); } catch (error) { this.logger.error(`stop ${bot.id} failed: ${error.message}`); }
        }
    }

    async destroyAll() {
        for (const bot of this.list()) {
            try { bot.destroy(); } catch (error) { this.logger.error(`destroy ${bot.id} failed: ${error.message}`); }
        }
        this.bots.clear();
    }
}

module.exports = { BotManager };
