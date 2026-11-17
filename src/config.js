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
            prefixes: ['v\\', '\u00b0'],
            // Chat tag set with /prefix, not to be confused with the command
            // prefixes above. "&" colour codes are passed through as written.
            prefix: '&a[prefix: v\\]',
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
        list: {
            // How often @a is asked who is online, which is what catches
            // vanished players. A tab list alone cannot see them.
            scanMs: 20000
        },
        alts: {
            enabled: true,
            // The bot cannot see addresses; it reads them back from a server
            // command whose output carries the address, and /seen is the one
            // every server has. Empty means /alts only reports what is already
            // stored.
            lookupCommand: 'seen {player}',
            // Tried when the lookup command gives back no address.
            fallbackCommand: '',
            // Only /identity reads this one: whois prints the fields /seen does
            // not (uuid, gamemode, money...). Addresses never come from it.
            detailCommand: 'whois {player}',
            cacheMs: 600000,
            gapMs: 1200,
            timeoutMs: 3000,
            rescanMs: 60000
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
        // Local terminal control. Only starts when stdin is a TTY.
        console: {
            enabled: true
        },
        // Two-way chat with Discord. Channels come from discord.channels[<id>]
        // or from the server's own channelId.
        discord: {
            enabled: false,
            token: '',
            guildId: '',
            commandPrefix: '!',
            channels: {},
            trustedId: '',
            adminId: '',
            ownerId: '',
            adminIds: [],
            relay: {
                chat: true,
                discord: true
            }
        },
        // Persistent per-server command loops (cloop).
        cloops: {
            enabled: true,
            minIntervalMs: 100
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
                block: 'minecraft:command_block',
                mode: 'replace',
                // How often a missing core is rebuilt, in milliseconds.
                intervalMs: 1000,
                // How fast "refill" spams fills through the core blocks.
                spamMs: 150,
                // Start the spam refill by itself once the core is placed.
                auto: false,
                // Refill and run commands through the bot's own command blocks,
                // placed from a creative slot packet: they only ever receive
                // block writes (setblock/fill) that put the command into a real
                // core block, so the core is never edited directly.
                item: true,
                // The blocks the bot places for itself: normal (impulse) blocks,
                // so a command runs once instead of every tick.
                itemBlock: 'minecraft:command_block',
                // How long the given item stays in the hotbar before it is cleared.
                breakDelayMs: 250
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
        channelId: entry.channelId ? String(entry.channelId) : null,
        nick: entry.nick ?? null,
        prefix: entry.prefix ?? null
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
