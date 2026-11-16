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
    const { parseChatLine, chatTextFromPacket } = require('../src/minecraft/chat');
    const { flatten } = require('../src/minecraft/text');
    const { normalizeUuid, offlineUuid, shortUuid } = require('../src/minecraft/uuid');
    const { playerInfoEntries } = require('../src/minecraft/players');
    const { Bot } = require('../src/bot/bot');

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

    await check('auth keys grant the matching rank', () => {
        assert.strictEqual(permissions.redeem({ name: 'Alex', key: 'wrong' }), null);
        assert.strictEqual(permissions.redeem({ name: 'Alex', key: 'admin-key' }), LEVEL.ADMIN);
        assert.strictEqual(permissions.levelFor({ name: 'Alex' }), LEVEL.ADMIN);
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

    // --- commands -----------------------------------------------------------
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

    const registry = new CommandRegistry({
        dir: path.join(ROOT, 'src', 'commands'),
        config,
        permissions,
        store,
        logger
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

    const run = async line => {
        sent.length = 0;
        await registry.dispatch({ bot: fakeBot, parsed: parseChatLine(line) });
        return sent[0];
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
        assert.match(await run('<Unranked> v:identity'), /need trusted rank/);
    });

    await check('trusted commands respond with identity data', async () => {
        const output = await run('<Steve> v:identity Alex');
        assert.match(output, /Alex — 069a79f4/);
        assert.match(output, /rank admin/);
        assert.match(output, /player list/);
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
