'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

class ConfigError extends Error {}

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaults() {
    return {
        minecraft: {
            version: false,
            servers: [],
            connection: {
                autoReconnect: true,
                reconnectDelayMs: 3000,
                maxReconnectDelayMs: 60000,
                maxAttempts: 0
            }
        },
        bot: {
            prefixes: ['v\\'],
            nick: null,
            // "tellraw" replies privately and needs the bot to be opped;
            // "chat" replies in normal chat.
            reply: 'tellraw'
        },
        permissions: {
            keys: { owner: '', admin: '', trusted: '' },
            // Names or uuids, one per entry. These are the only source of ranks
            // besides the database, so the owner has to stay listed here.
            owner: ['VojtaV12'],
            admin: [],
            trusted: []
        },
        selfCare: {
            enabled: true,
            // Ask for op when we have none, then stay in creative.
            creative: true,
            commandSpy: true,
            vanish: true,
            // Undo a mute as soon as the server announces it.
            unmute: true,
            // One-shot per session; both need a name to send.
            nick: false,
            nickName: null,
            username: false,
            usernameName: null
        },
        storage: {
            path: 'data/vbot.sqlite'
        },
        logging: {
            level: 'info',
            chat: true
        },
        chat: {
            // "auto" trusts unsigned chat until the server proves it signs
            // player chat; true always trusts it; false never does.
            trustUnsigned: 'auto'
        },
        core: {
            enabled: true,
            // Raw SNBT component for the blocks' CustomName, or null for none.
            // Example: {"text":"vbot","color":"green"}
            name: null,
            area: { size: 9, y: 64 },
            refill: {
                enabled: true,
                block: 'minecraft:repeating_command_block',
                mode: 'replace',
                // How often a missing core is rebuilt, in milliseconds.
                intervalMs: 2000
            }
        }
    };
}

function merge(base, override) {
    if (!isObject(override)) return base;
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
        out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
    }
    return out;
}

function normalizeServer(entry, index) {
    const where = `minecraft.servers[${index}]`;
    if (!isObject(entry)) throw new ConfigError(`${where} must be an object`);

    const id = String(entry.id || '').trim();
    if (!id) throw new ConfigError(`${where}.id is required`);

    const host = String(entry.host || '').trim();
    if (!host) throw new ConfigError(`${where}.host is required`);

    const username = String(entry.username || '').trim();
    if (!username) throw new ConfigError(`${where}.username is required`);

    const port = Number(entry.port ?? 25565);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigError(`${where}.port must be a port number`);
    }

    return {
        id,
        enabled: entry.enabled !== false,
        host,
        port,
        username,
        auth: entry.auth === 'microsoft' ? 'microsoft' : 'offline',
        version: entry.version ?? false,
        nick: entry.nick ?? null
    };
}

function loadConfig(configPath = process.env.VBOT_CONFIG || path.join(ROOT, 'config.json')) {
    let raw;
    try {
        raw = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
        throw new ConfigError(
            `Could not read ${configPath} (${error.code || error.message}). ` +
            'Copy config.example.json to config.json and fill it in.'
        );
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new ConfigError(`config.json is not valid JSON: ${error.message}`);
    }
    if (!isObject(parsed)) throw new ConfigError('config.json must contain an object');

    const config = merge(defaults(), parsed);
    const servers = Array.isArray(config.minecraft.servers) ? config.minecraft.servers : [];
    const seen = new Set();
    config.minecraft.servers = servers.map((entry, index) => {
        const server = normalizeServer(entry, index);
        if (seen.has(server.id)) throw new ConfigError(`duplicate server id "${server.id}"`);
        seen.add(server.id);
        return server;
    });

    if (!Array.isArray(config.bot.prefixes) || !config.bot.prefixes.length) {
        throw new ConfigError('bot.prefixes must be a non-empty array');
    }
    config.bot.prefixes = config.bot.prefixes.map(prefix => String(prefix)).filter(Boolean);

    const connection = config.minecraft.connection;
    connection.reconnectDelayMs = Math.max(250, Number(connection.reconnectDelayMs) || 3000);
    connection.maxReconnectDelayMs = Math.max(
        connection.reconnectDelayMs,
        Number(connection.maxReconnectDelayMs) || 60000
    );
    connection.maxAttempts = Math.max(0, Number(connection.maxAttempts) || 0);

    return config;
}

function enabledServers(config) {
    return config.minecraft.servers.filter(server => server.enabled);
}

module.exports = { ConfigError, loadConfig, enabledServers, ROOT };
