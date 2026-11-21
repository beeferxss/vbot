'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

class ConfigError extends Error {}

// A name nobody picked: eight characters of letters and numbers, with the mix a
// player name has (a capital, a lower-case letter and a digit somewhere). It is
// rolled once per run, so the bot keeps the name it joined with - a reconnect
// with a new name would lose op, its records and anything else tied to it.
const RANDOM_NAME_LENGTH = 8;

function randomName(length = RANDOM_NAME_LENGTH) {
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const all = upper + lower + digits;
    const pick = chars => chars[Math.floor(Math.random() * chars.length)];

    // Guaranteed to have a capital, a lower-case letter and a digit; the rest is
    // anything.
    const chars = length >= 3 ? [pick(upper), pick(lower), pick(digits)] : [];
    while (chars.length < length) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

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
                maxAttempts: 0,
                // A server that takes the socket and then says nothing leaves the
                // bot "connecting" forever; this is how long it waits for the
                // login packet before the attempt is failed and retried.
                loginTimeoutMs: 30000
            }
        },
        bot: {
            prefixes: ['\\', '\u00b0'],
            // In-game commands are started by one of `prefixes` above. Off: no
            // chat line can run a command, and only Discord (and the console)
            // reach the bot.
            inGamePrefixes: true,
            // Chat tag set with /prefix, not to be confused with the command
            // prefixes above. "&" colour codes are passed through as written.
            prefix: '&a[prefix: v\\]',
            // Off by default: many servers reject /prefix or leave the tag on
            // after the bot restarts, so the tag is only sent when asked for.
            prefixEnabled: false,
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
        // The version each player joins on, read from ViaVersion: it is not in
        // the tab list, so `/viaver player <name>` is asked and the answer is
        // kept as the last version seen. `alts` shows it on the name's hover.
        versions: {
            enabled: true,
            command: 'viaver player {player}',
            // A version is re-read while the player is online, and the join
            // lookup is skipped when the stored one is this fresh.
            cacheMs: 600000,
            gapMs: 1500,
            timeoutMs: 4000,
            rescanMs: 300000
        },
        // A player who joins with mail waiting is told privately how much there
        // is, so an unread message is never silent. The notice waits for the
        // world and the core, and is retried while the player is still online.
        mail: {
            notifyOnJoin: true,
            delayMs: 4000,
            retryMs: 2500,
            attempts: 16
        },
        selfCare: {
            enabled: true,
            // A bot teleported into the end (or the nether) is brought back to
            // where it last stood in the overworld; nothing else can leave it.
            recoverWorld: true,
            // Ask for op when we have none, then stay in creative.
            creative: true,
            commandSpy: true,
            vanish: true,
            // Undo a mute as soon as the server announces it.
            unmute: true,
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
        // A server that filters bots deops them in a loop instead of kicking
        // them. That many deops in a minute is the filter: the bot leaves, the
        // WARP address is changed, and it comes back. After the last change it
        // stays in game - a whitelist is what keeps it online by then.
        filterGuard: {
            enabled: true,
            deopsPerMinute: 40,
            rotations: 3,
            // A new address belongs to the whole runner, so every other bot is
            // reconnected on it too. Off by default: it interrupts all of them.
            allServers: false
        },
        // Cloudflare WARP, for the address changes above: warproxy keeps a SOCKS5
        // proxy on localhost whose tunnel is the address the server sees, and the
        // bot's connections go through it. Without warproxy every call fails
        // softly and the bot connects directly.
        warp: {
            enabled: false,
            host: '127.0.0.1',
            port: 25344,
            timeoutMs: 180000
        },
        core: {
            enabled: true,
            // Raw SNBT component for the blocks' CustomName, or null for none.
            // Example: {"text":"vbot","color":"green"}
            name: null,
            // `y` is the level the area is filled at, whatever height the bot is
            // standing at; -30 keeps the cube underground and out of the way.
            area: { size: 9, y: -30 },
            // The bot drops itself at a random spot as soon as it joins, before
            // anything is filled, so the core is never built at the server's
            // spawn. Same range and height as the "rtp" command.
            joinRtp: {
                enabled: true,
                range: 10000000,
                height: 100,
                // How long the teleport gets to land before the core is built
                // where the bot stands anyway.
                waitMs: 6000
            },
            refill: {
                enabled: true,
                block: 'minecraft:repeating_command_block',
                mode: 'replace',
                // How often a missing core is rebuilt, in milliseconds.
                intervalMs: 1000,
                // How fast "refill" spams fills through the core blocks.
                spamMs: 150,
                // Start the spam refill by itself once the core is placed.
                auto: false,
                // Keep a mini core of the bot's own: size x size x size command
                // blocks above its head, put down with one /fill and written into
                // by packet. Nothing is placed from the inventory, so this needs
                // no item, no slot packet and no block in hand.
                item: true,
                // Blocks on a side of the mini core's cube: 4 is 64 blocks. It is
                // filled again where it was built as soon as any of its blocks go
                // missing, and only moved once the bot is far away from it.
                miniSize: 4,
                // The cube is filled unnamed: a block nobody named is one more
                // thing that looks untouched.
                miniName: null,
                // Send the fill, and a command no core block took, as plain chat
                // when the bot has nothing of its own to run it in: that is the
                // only way to build the first core block on a server that does
                // not let the bot place one.
                chatFallback: true
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

    // A random name is rolled here, once, so every part of the bot sees the same
    // one for the whole run: `randomName: true` is all a server needs then.
    const wanted = String(entry.username || '').trim();
    const random = entry.randomName === true;
    if (!wanted && !random) {
        throw new ConfigError(`${where}.username is required (or set randomName: true)`);
    }

    const port = Number(entry.port ?? 25565);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigError(`${where}.port must be a port number`);
    }

    return {
        id,
        enabled: entry.enabled !== false,
        host,
        port,
        username: wanted || randomName(),
        randomName: Boolean(random),
        auth: entry.auth === 'microsoft' ? 'microsoft' : 'offline',
        version: entry.version ?? false,
        channelId: entry.channelId ? String(entry.channelId) : null,
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

    if (!Array.isArray(config.bot.prefixes)) {
        throw new ConfigError('bot.prefixes must be an array');
    }
    config.bot.prefixes = config.bot.prefixes.map(prefix => String(prefix)).filter(Boolean);
    config.bot.inGamePrefixes = config.bot.inGamePrefixes !== false;
    if (config.bot.inGamePrefixes && !config.bot.prefixes.length) {
        throw new ConfigError('bot.prefixes must be a non-empty array (or set bot.inGamePrefixes: false)');
    }

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

module.exports = { ConfigError, loadConfig, enabledServers, randomName, ROOT };
