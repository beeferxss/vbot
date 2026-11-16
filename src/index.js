'use strict';

const path = require('node:path');
const { loadConfig, ConfigError } = require('./config');
const { Logger } = require('./logger');
const { Store } = require('./db');
const { Permissions } = require('./permissions');
const { Tokens } = require('./auth/tokens');
const { CommandRegistry } = require('./commands');
const { BotManager } = require('./bot/manager');

async function main() {
    let config;
    try {
        config = loadConfig();
    } catch (error) {
        if (error instanceof ConfigError) {
            console.error(`Config error: ${error.message}`);
            process.exit(1);
        }
        throw error;
    }

    const logger = new Logger(config.logging);
    const store = new Store(path.resolve(__dirname, '..', config.storage.path)).open();
    const permissions = new Permissions({ config, store, logger });
    const tokens = new Tokens({ keys: config.permissions.keys, logger });
    const registry = new CommandRegistry({
        dir: path.join(__dirname, 'commands'),
        config,
        permissions,
        store,
        logger,
        tokens
    }).loadAll();

    // Installed before any socket exists: a first-connect failure must be
    // reported, not crash the process.
    process.on('unhandledRejection', error => logger.error('unhandled rejection:', error));
    process.on('uncaughtException', error => logger.error('uncaught exception:', error));

    const manager = new BotManager({ config, store, permissions, registry, logger });
    manager.on('ready', bot => logger.info(`${bot.id} ready`));
    manager.on('disconnect', (bot, reason) => logger.warn(`${bot.id} disconnected: ${reason || 'unknown'}`));
    manager.on('failed', bot => logger.error(`${bot.id} stopped retrying`));
    manager.on('chat', (bot, event) => {
        if (event.parsed) logger.debug(`[${bot.id}] ${event.parsed.username}: ${event.parsed.message}`);
    });

    const bots = await manager.startAll();
    if (!bots.length) {
        logger.error('nothing to run: enable at least one server in config.json');
        store.close();
        process.exit(1);
    }
    logger.info(`vbot started with ${bots.length} bot(s)`);

    let stopping = false;
    const shutdown = async signal => {
        if (stopping) return;
        stopping = true;
        logger.info(`${signal} received, shutting down`);
        await manager.destroyAll();
        store.close();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    return manager;
}

if (require.main === module) {
    main().catch(error => {
        console.error('Fatal:', error);
        process.exit(1);
    });
}

module.exports = { main };
