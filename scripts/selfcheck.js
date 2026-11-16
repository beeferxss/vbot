'use strict';

// Offline self-check: everything here runs without a Minecraft server or
// network access, so it works locally and in CI. Exit code is non-zero on
// the first failed check.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const results = [];
let failed = 0;

async function check(name, fn) {
    try {
        await fn();
        results.push(`ok   ${name}`);
    } catch (error) {
        failed += 1;
        results.push(`FAIL ${name}\n     ${String(error.message).split('\n').join('\n     ')}`);
    }
}

function tmpConfig(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-selfcheck-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return file;
}

async function main() {
    const { loadConfig, ConfigError } = require('../src/config');
    const { Logger } = require('../src/logger');
    const { Store } = require('../src/db');
    const { Permissions, LEVEL } = require('../src/permissions');
    const { CommandRegistry } = require('../src/commands');
    const { Tokens } = require('../src/auth/tokens');
    const { parseChatLine, chatTextFromPacket, chatEventFromPacket } = require('../src/minecraft/chat');
    const { flatten } = require('../src/minecraft/text');
    const { normalizeUuid, offlineUuid, shortUuid } = require('../src/minecraft/uuid');
    const { playerInfoEntries } = require('../src/minecraft/players');
    const { Bot } = require('../src/bot/bot');
    const { Core } = require('../src/core');

    const logger = new Logger({ level: 'error' });
    const examplePath = path.join(ROOT, 'config.example.json');

    // --- config -------------------------------------------------------------
    await check('example config has complete, uniquely named servers', () => {
        const config = loadConfig(examplePath);
        assert.ok(config.minecraft.servers.length > 0, 'expected servers');
        const ids = config.minecraft.servers.map(server => server.id);
        assert.strictEqual(new Set(ids).size, ids.length, 'server ids must be unique');
        for (const server of config.minecraft.servers) {
            assert.ok(server.host && server.port && server.username, `incomplete server ${server.id}`);
        }
    });

    await check('config defaults are merged in', () => {
        const config = loadConfig(examplePath);
        assert.strictEqual(config.minecraft.connection.autoReconnect, true);
        assert.strictEqual(config.storage.path, 'data/vbot.sqlite');
        assert.deepStrictEqual(config.permissions.keys, { owner: '', admin: '', trusted: '' });
    });

    await check('config rejects a server without a host', () => {
        const file = tmpConfig({ minecraft: { servers: [{ id: 'x', username: 'u' }] } });
        assert.throws(() => loadConfig(file), ConfigError, 'expected ConfigError');
    });

    await check('config rejects duplicate server ids', () => {
        const file = tmpConfig({
            minecraft: {
                servers: [
                    { id: 'dup', host: 'a', username: 'u' },
                    { id: 'dup', host: 'b', username: 'u' }
                ]
            }
        });
        assert.throws(() => loadConfig(file), /duplicate server id/, 'expected duplicate error');
    });

    await check('config rejects invalid JSON', () => {
        const file = tmpConfig('{ not json');
        assert.throws(() => loadConfig(file), ConfigError);
    });

    // --- uuid ---------------------------------------------------------------
    await check('offline uuids match minecraft-protocol (200 names)', () => {
        let reference;
        try {
            reference = require('minecraft-protocol/src/datatypes/uuid').nameToMcOfflineUUID;
        } catch {
            return; // dependency missing: covered by the install step instead
        }
        const names = ['Steve', 'jeb_', 'a', 'Player_123', 'Ünïcodé'];
        for (let i = 0; i < 200; i++) names.push(`player${i}`);
        for (const name of names) assert.strictEqual(offlineUuid(name), reference(name), name);
    });

    await check('offline uuid is version 3, case sensitive, never null', () => {
        const uuid = offlineUuid('Steve');
        assert.strictEqual(uuid[14], '3');
        assert.ok(['8', '9', 'a', 'b'].includes(uuid[19]), 'variant nibble');
        assert.notStrictEqual(uuid, offlineUuid('steve'));
        assert.strictEqual(offlineUuid(''), null);
    });

    await check('normalizeUuid accepts every wire shape', () => {
        const expected = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
        assert.strictEqual(normalizeUuid(expected.toUpperCase()), expected);
        assert.strictEqual(normalizeUuid(expected.replace(/-/g, '')), expected);
        assert.strictEqual(normalizeUuid(Buffer.from(expected.replace(/-/g, ''), 'hex')), expected);
        assert.strictEqual(normalizeUuid([0x069a79f4, 0x44e94726, 0xa5befca9, 0x0e38aaf5]), expected);
        assert.strictEqual(normalizeUuid('not-a-uuid'), null);
        assert.strictEqual(shortUuid(expected), '069a79f4');
    });

    await check('player list packets parse in both shapes', () => {
        const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
        assert.deepStrictEqual(
            playerInfoEntries({ action: 0, data: [{ uuid, name: 'Notch' }] }),
            [{ name: 'Notch', uuid }]
        );
        assert.deepStrictEqual(
            playerInfoEntries({ entries: [{ uuid: Buffer.from(uuid.replace(/-/g, ''), 'hex'), name: 'Notch' }] }),
            [{ name: 'Notch', uuid }]
        );
        assert.deepStrictEqual(playerInfoEntries(null), []);
    });

    // --- chat ---------------------------------------------------------------
    await check('chat lines parse for the common server formats', () => {
        assert.deepStrictEqual(parseChatLine('<Steve> v:help'), { username: 'Steve', message: 'v:help' });
        assert.deepStrictEqual(parseChatLine('Alex: v:help'), { username: 'Alex', message: 'v:help' });
        assert.deepStrictEqual(parseChatLine('[ADMIN] Alex » v:help'), { username: 'Alex', message: 'v:help' });
        assert.strictEqual(parseChatLine('Steve joined the game'), null);
        assert.strictEqual(parseChatLine(''), null);
    });

    await check('chat packets decode JSON strings and components', () => {
        assert.strictEqual(
            chatTextFromPacket({ message: JSON.stringify({ text: '<Alex> ', extra: [{ text: 'v:ping' }] }) }),
            '<Alex> v:ping'
        );
        assert.strictEqual(chatTextFromPacket({ signedChat: { text: '<Alex> v:ping' } }), '<Alex> v:ping');
        assert.strictEqual(flatten({ translate: 'chat.type.text', with: ['Alex', 'hi'] }), 'chat.type.textAlexhi');
        assert.strictEqual(chatTextFromPacket(null), '');
    });

    await check('player chat packets carry a trusted sender and uuid', () => {
        const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
        const event = chatEventFromPacket('player_chat', {
            senderUuid: uuid,
            networkName: { text: '[ADMIN] Alex' },
            plainMessage: '|>help'
        });
        assert.strictEqual(event.verified, true);
        assert.strictEqual(event.username, 'Alex');
        assert.strictEqual(event.message, '|>help');
        assert.strictEqual(event.uuid, uuid);

        // Anything printed by the server is free-form and cannot be trusted to
        // come from the player it claims to be.
        const forged = chatEventFromPacket('system_chat', { content: { text: '<Steve> |>help' } });
        assert.strictEqual(forged.verified, false);
        assert.deepStrictEqual(parseChatLine(forged.line), { username: 'Steve', message: '|>help' });
    });

    // --- store, permissions, bot -------------------------------------------
    const store = new Store(':memory:').open();
    const config = loadConfig(examplePath);
    config.bot.prefixes = ['v:'];
    config.permissions.keys.admin = 'admin-key';
    const permissions = new Permissions({ config, store, logger });
    const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5';

    await check('store links a name to a uuid and finds it both ways', () => {
        store.setUserLevel('Steve', LEVEL.ADMIN, 'selfcheck');
        store.linkPlayer('Steve', uuid);
        assert.strictEqual(store.getPlayerByUUID(uuid).name, 'Steve');
        assert.strictEqual(store.getUserByUUID(uuid).level, LEVEL.ADMIN);
        assert.strictEqual(store.getPlayer('steve').uuid, uuid);
    });

    await check('renamed player keeps their rank through the uuid', () => {
        assert.strictEqual(permissions.levelFor({ name: 'Steve', uuid }), LEVEL.ADMIN);
        assert.strictEqual(permissions.levelFor({ name: 'Steve_Renamed', uuid }), LEVEL.ADMIN);
        assert.strictEqual(permissions.levelFor({ name: 'Steve_Renamed' }), LEVEL.PUBLIC);
    });

    await check('config lists match by uuid as well as name', () => {
        config.permissions.owner = [uuid];
        assert.strictEqual(permissions.levelFor({ name: 'someone', uuid }), LEVEL.OWNER);
        config.permissions.owner = [];
    });

    await check('auth tokens prove a rank once and expire', () => {
        const keys = { trusted: 'trusted-key', admin: 'admin-key', owner: 'owner-key' };

        const adminTokens = new Tokens({ keys });
        const adminToken = adminTokens.issue(LEVEL.ADMIN).token;
        assert.strictEqual(adminToken.length, 16);
        assert.strictEqual(adminTokens.verify(adminToken), LEVEL.ADMIN);
        assert.strictEqual(adminTokens.verify(adminToken), null, 'replay must be refused');

        const trustedTokens = new Tokens({ keys });
        const trustedToken = trustedTokens.issue(LEVEL.TRUSTED).token;
        assert.strictEqual(trustedToken.length, 8);
        assert.strictEqual(trustedTokens.verify(trustedToken), LEVEL.TRUSTED);

        const unknown = new Tokens({ keys });
        assert.strictEqual(unknown.verify('deadbeef'), null);
        assert.strictEqual(unknown.verify(''), null);
        assert.strictEqual(new Tokens({ keys: {} }).issue(LEVEL.ADMIN), null, 'no key means no token');
    });

    const bot = new Bot({
        server: { id: 'selfcheck', host: '127.0.0.1', port: 1, username: 'vbot', auth: 'offline' },
        config,
        store,
        permissions,
        registry: { dispatch: async () => {} },
        logger
    });

    await check('offline bots derive uuids, online bots stay unknown', () => {
        assert.strictEqual(bot.uuidFor('Notch'), offlineUuid('Notch'));
        const online = new Bot({
            server: { id: 'online', host: '127.0.0.1', port: 1, username: 'vbot', auth: 'microsoft' },
            config,
            store,
            permissions,
            registry: { dispatch: async () => {} },
            logger
        });
        assert.strictEqual(online.uuidFor('NobodySeenYet'), null);
    });

    await check('player list packets feed the bot cache', () => {
        bot.handlePlayerInfo({ entries: [{ uuid, name: 'Alex' }] });
        assert.strictEqual(bot.uuidFor('Alex'), uuid);
        assert.strictEqual(store.getPlayer('Alex').uuid, uuid);
    });

    await check('names inside NBT components are decoded', () => {
        // This is what minecraft-protocol actually hands over for networkName.
        const event = chatEventFromPacket('player_chat', {
            senderUuid: uuid,
            networkName: { type: 'compound', value: { text: { type: 'string', value: '[ADMIN] Alex' } } },
            plainMessage: '|>help'
        });
        assert.strictEqual(event.username, 'Alex');
        assert.strictEqual(event.line, '<Alex> |>help');
        assert.deepStrictEqual(parseChatLine(event.line), { username: 'Alex', message: '|>help' });

        const system = chatEventFromPacket('system_chat', {
            content: { type: 'compound', value: { text: { type: 'string', value: '<Steve> |>whoami' } } }
        });
        assert.strictEqual(system.verified, false);
        assert.deepStrictEqual(parseChatLine(system.line), { username: 'Steve', message: '|>whoami' });
    });

    await check('the nickname is taken from config, per server wins', () => {
        assert.strictEqual(bot.nickName(), config.bot.nick);
        assert.strictEqual(bot.nickName(), 'vbot');

        const perServer = new Bot({
            server: { id: 'nick', host: '127.0.0.1', port: 1, username: 'vbot', auth: 'offline', nick: 'other' },
            config,
            store,
            permissions,
            registry: { dispatch: async () => {} },
            logger
        });
        assert.strictEqual(perServer.nickName(), 'other');

        config.bot.nick = null;
        assert.strictEqual(bot.nickName(), null);
        config.bot.nick = 'vbot';
    });

    await check('core fills its area and rotates through blocks', () => {
        const sent = [];
        const writes = [];
        const coreBot = {
            position: { x: 35, y: 70, z: -3 },
            chat: command => sent.push(command),
            write: (name, payload) => writes.push({ name, payload }),
            log: logger
        };
        const coreConfig = { enabled: true, area: { size: 16, y: 64 }, refill: { enabled: true } };
        const core = new Core({ bot: coreBot, config: coreConfig, logger });

        assert.strictEqual(core.reset(), true);
        assert.deepStrictEqual(core.origin, { x: 32, y: 64, z: -16 });
        assert.deepStrictEqual(core.bounds, { x: 47, y: 79, z: -1 });

        core.refill('test');
        assert.strictEqual(
            sent[0],
            '/fill 32 64 -16 47 79 -1 minecraft:repeating_command_block replace'
        );

        const first = core.run('say hello');
        const second = core.run('/gamemode creative');
        assert.deepStrictEqual(first, { x: 32, y: 64, z: -16 });
        assert.notDeepStrictEqual(second, first, 'commands must use different blocks');
        assert.strictEqual(writes[0].name, 'update_command_block');
        assert.strictEqual(writes[0].payload.command, 'say hello');
        assert.strictEqual(writes[1].payload.command, 'gamemode creative');

        // Our own writes must not look like damage.
        assert.strictEqual(core.onBlockChange({ location: first }), false);
        assert.strictEqual(core.onBlockChange({ location: { x: 999, y: 999, z: 999 } }), false);
        assert.strictEqual(core.onBlockChange({ location: { x: 40, y: 70, z: -10 } }), true);
    });

    await check('core refills itself when a block is damaged', async () => {
        const sent = [];
        const coreBot = {
            position: { x: 0, y: 70, z: 0 },
            chat: command => sent.push(command),
            write: () => {},
            log: logger
        };
        const core = new Core({
            bot: coreBot,
            config: { enabled: true, area: { size: 4, y: 64 }, refill: { enabled: true } },
            logger
        });
        core.reset();
        core.refill('startup');
        sent.length = 0;

        core.onBlockChange({ location: { x: 1, y: 64, z: 1 } });
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.strictEqual(sent.length, 1, 'damage should trigger exactly one refill');
        assert.match(sent[0], /^\/fill 0 64 0 3 67 3 /);
        core.destroy();
    });

    // --- commands -----------------------------------------------------------
    await check('database stores only identity and ranks', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-schema-'));
        const scratch = new Store(path.join(dir, 'vbot.sqlite')).open();
        const columns = table =>
            scratch.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);

        assert.deepStrictEqual(columns('players'), ['name_key', 'name', 'uuid', 'first_seen', 'last_seen']);
        assert.deepStrictEqual(columns('users'), ['name_key', 'name', 'uuid', 'level', 'granted_by', 'granted_at']);

        const tables = scratch.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map(row => row.name)
            .filter(name => !name.startsWith('sqlite_'));
        assert.deepStrictEqual(tables.sort(), ['players', 'users'], `unexpected tables: ${tables}`);
        scratch.close();
    });

    await check('older databases lose the dropped column and table', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-migrate-'));
        const file = path.join(dir, 'vbot.sqlite');
        const { DatabaseSync } = require('node:sqlite');
        const old = new DatabaseSync(file);
        old.exec(`
            CREATE TABLE players (
                name_key TEXT PRIMARY KEY, name TEXT NOT NULL, uuid TEXT,
                first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
                messages INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
            INSERT INTO players VALUES ('steve', 'Steve', NULL, 111, 222, 42);
            INSERT INTO meta VALUES ('noise', 'drop me');
        `);
        old.close();

        const migrated = new Store(file).open();
        const columns = migrated.db.prepare('PRAGMA table_info(players)').all().map(row => row.name);
        assert.ok(!columns.includes('messages'), 'message counter should be gone');
        const steve = migrated.getPlayer('Steve');
        assert.strictEqual(steve.first_seen, 111);
        assert.strictEqual(steve.last_seen, 222);
        const tables = migrated.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map(row => row.name);
        assert.ok(!tables.includes('meta'), 'meta table should be dropped');
        migrated.close();
    });

    await check('store checkpoints the WAL before the database is committed', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-db-'));
        const file = path.join(dir, 'vbot.sqlite');
        const scratch = new Store(file).open();
        scratch.setUserLevel('Steve', LEVEL.ADMIN, 'selfcheck');
        scratch.checkpoint();
        const wal = `${file}-wal`;
        const walSize = fs.existsSync(wal) ? fs.statSync(wal).size : 0;
        assert.strictEqual(walSize, 0, 'write-ahead log should be empty after checkpoint');
        scratch.close();
        assert.ok(fs.statSync(file).size > 0, 'database file should hold data');
    });

    const tokens = new Tokens({ keys: { trusted: 'trusted-key', admin: 'admin-key', owner: 'owner-key' } });
    const registry = new CommandRegistry({
        dir: path.join(ROOT, 'src', 'commands'),
        config,
        permissions,
        store,
        logger,
        tokens
    }).loadAll();

    const sent = [];
    const fakeBot = {
        client: { latency: 12 },
        registry,
        log: logger,
        chat: text => sent.push(text),
        uuidFor: name => bot.uuidFor(name),
        server: { auth: 'offline' }
    };

    const decodeReply = message => {
        const match = /^\/tellraw (\S+) (.*)$/s.exec(String(message || ''));
        if (!match) return message;
        try {
            const component = JSON.parse(match[2]);
            const parts = Array.isArray(component) ? component : [component];
            return parts.map(part => part.text ?? '').join('');
        } catch {
            return message;
        }
    };

    const run = async line => {
        sent.length = 0;
        await registry.dispatch({ bot: fakeBot, parsed: parseChatLine(line) });
        return decodeReply(sent[0]);
    };

    await check('commands load with unique names and aliases', () => {
        assert.ok(registry.commands.size >= 5, `expected commands, got ${registry.commands.size}`);
        assert.ok(registry.find('whois'), 'identity alias missing');
        assert.strictEqual(registry.find('whoami').name, 'whoami');
    });

    await check('help only lists commands the caller can use', async () => {
        const output = await run('<Unranked> v:help');
        assert.match(output, /Commands for public/);
        assert.ok(!output.includes('identity'), 'trusted command leaked to public help');
    });

    await check('unknown commands and rank gates reply instead of throwing', async () => {
        assert.match(await run('<Unranked> v:nope'), /Unknown command "nope"/);
        assert.match(await run('<Unranked> v:identity'), /needs a trusted token/);
    });

    await check('a stored rank cannot be borrowed by forged chat on a signing server', async () => {
        // Steve is admin in the store, but this line did not arrive as signed
        // player chat and the server has proven it can sign, so it must not
        // inherit that rank.
        fakeBot.signedChatSeen = true;
        sent.length = 0;
        await registry.dispatch({
            bot: fakeBot,
            parsed: { username: 'Steve', message: 'v:identity Alex' },
            verified: false
        });
        assert.match(sent[0], /needs a trusted token/);

        // The same line with a fresh trusted token is accepted.
        const token = tokens.issue(LEVEL.TRUSTED).token;
        const output = await run(`<Unranked> v:identity ${token} Alex`);
        assert.match(output, /Alex — 069a79f4/);
    });

    await check('servers without chat signing still apply ranks', async () => {
        fakeBot.signedChatSeen = false;
        sent.length = 0;
        await registry.dispatch({
            bot: fakeBot,
            parsed: { username: 'Steve', message: 'v:identity Alex' },
            verified: false
        });
        assert.match(sent[0], /Alex — 069a79f4/);

        // trustUnsigned: false keeps unsigned chat out even without signing.
        const strict = loadConfig(examplePath);
        strict.bot.prefixes = ['v:'];
        strict.chat = { trustUnsigned: false };
        const strictRegistry = new CommandRegistry({
            dir: path.join(ROOT, 'src', 'commands'),
            config: strict,
            permissions,
            store,
            logger,
            tokens
        }).loadAll();
        sent.length = 0;
        await strictRegistry.dispatch({
            bot: { ...fakeBot, signedChatSeen: false },
            parsed: { username: 'Steve', message: 'v:identity Alex' },
            verified: false
        });
        assert.match(sent[0], /needs a trusted token/);
    });

    await check('trusted commands respond with identity data', async () => {
        const output = await run('<Steve> v:identity Alex');
        assert.match(output, /Alex — 069a79f4/);
        assert.match(output, /rank admin/);
        assert.match(output, /player list/);
    });

    await check('replies are private tellraw, with a chat fallback', async () => {
        sent.length = 0;
        await registry.dispatch({ bot: fakeBot, parsed: parseChatLine('<Unranked> v:help') });
        assert.match(sent[0], /^\/tellraw Unranked \{/);
        assert.match(decodeReply(sent[0]), /Commands for public/);

        const chatConfig = loadConfig(examplePath);
        chatConfig.bot.prefixes = ['v:'];
        chatConfig.bot.reply = 'chat';
        const chatRegistry = new CommandRegistry({
            dir: path.join(ROOT, 'src', 'commands'),
            config: chatConfig,
            permissions,
            store,
            logger,
            tokens
        }).loadAll();
        sent.length = 0;
        await chatRegistry.dispatch({ bot: fakeBot, parsed: parseChatLine('<Unranked> v:ping') });
        assert.match(sent[0], /^pong/);
    });

    await check('bot chat routes server commands through the core', () => {
        const spoken = [];
        const packets = [];
        const routingBot = new Bot({
            server: { id: 'routing', host: '127.0.0.1', port: 1, username: 'vbot', auth: 'offline' },
            config,
            store,
            permissions,
            registry: { dispatch: async () => {} },
            logger
        });
        routingBot.client = {
            chat: text => spoken.push(text),
            write: (name, payload) => packets.push({ name, payload })
        };
        routingBot.state = 'ready';

        // With no core yet a command can only be chat.
        routingBot.chat('/say hi');
        assert.deepStrictEqual(spoken, ['/say hi']);

        const core = new Core({
            bot: routingBot,
            config: { enabled: true, area: { size: 2, y: 64 }, refill: { enabled: true } },
            logger
        });
        routingBot.core = core;
        core.reset({ x: 0, y: 70, z: 0 });
        core.ready = true;

        spoken.length = 0;
        routingBot.chat('/gamemode creative vbot');
        assert.deepStrictEqual(spoken, [], 'server commands must not reach chat');
        assert.strictEqual(packets.length, 1);
        assert.strictEqual(packets[0].name, 'update_command_block');
        assert.strictEqual(packets[0].payload.command, 'gamemode creative vbot');

        // Normal messages still go to chat.
        routingBot.chat('hello world');
        assert.deepStrictEqual(spoken, ['hello world']);

        // Refills reuse a block instead of spamming chat.
        packets.length = 0;
        core.refill('damaged');
        assert.deepStrictEqual(spoken, ['hello world']);
        assert.match(packets[0].payload.command, /^fill 0 64 0 1 65 1 /);
        core.destroy();
    });

    await check('uuid and whoami commands answer', async () => {
        assert.match(await run('<Steve> v:uuid Notch'), /offline: [0-9a-f-]{36}/);
        assert.match(await run('<Steve> v:whoami'), /You are admin/);
        assert.match(await run('<Steve> v:ping'), /pong/);
    });

    store.close();

    console.log(results.join('\n'));
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    if (failed) {
        console.error(`${failed} check(s) failed`);
        process.exit(1);
    }
}

main().catch(error => {
    console.error('selfcheck crashed:', error);
    process.exit(1);
});
