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

    await check('a server can ask for a random name instead of a fixed one', () => {
        const { randomName } = require('../src/config');

        // Eight characters of letters and numbers, capital and lower case, with a
        // digit in it: what a player name looks like and what Minecraft accepts.
        for (let i = 0; i < 200; i++) {
            const name = randomName();
            assert.match(name, /^[A-Za-z0-9]{8}$/, `eight letters or numbers: ${name}`);
            assert.match(name, /[A-Z]/, 'a capital letter');
            assert.match(name, /[a-z]/, 'a lower-case letter');
            assert.match(name, /\d/, 'a number');
        }

        const file = tmpConfig({
            minecraft: {
                servers: [
                    { id: 'one', host: 'a', randomName: true },
                    { id: 'two', host: 'b', port: 25566, randomName: true }
                ]
            }
        });
        const config = loadConfig(file);
        const [one, two] = config.minecraft.servers;
        assert.match(one.username, /^[A-Za-z0-9]{8}$/, 'the first name is rolled');
        assert.strictEqual(one.randomName, true);
        assert.match(two.username, /^[A-Za-z0-9]{8}$/, 'the second name is rolled');
        assert.notStrictEqual(one.username, two.username, 'each server gets its own name');

        // A fixed name still wins, and a server with neither is still an error.
        const fixed = loadConfig(tmpConfig({
            minecraft: { servers: [{ id: 'f', host: 'h', username: 'vbot' }] }
        }));
        assert.strictEqual(fixed.minecraft.servers[0].username, 'vbot');
        assert.strictEqual(fixed.minecraft.servers[0].randomName, false);
        assert.throws(() => loadConfig(tmpConfig({
            minecraft: { servers: [{ id: 'n', host: 'h' }] }
        })), /username is required/);
    });

    await check('config defaults are merged in', () => {
        const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
        const config = loadConfig(examplePath);
        assert.strictEqual(config.minecraft.connection.autoReconnect, true);
        assert.strictEqual(config.storage.path, 'data/vbot.sqlite');
        assert.deepStrictEqual(config.permissions.keys, { owner: '', admin: '', trusted: '' });
        // The example is the bot's own config and is tuned by hand: what it says is
        // kept as it is, and only what it leaves out comes from the defaults.
        assert.deepStrictEqual(config.core.area, example.core.area, 'the example keeps its own core area');
        assert.ok(config.core.area.size >= 3, 'the core has a size to build from');
        assert.strictEqual(config.core.joinRtp.enabled, example.core.joinRtp.enabled,
            'the example keeps its own join');
        assert.strictEqual(config.core.joinRtp.range, 10000000, 'the rest of the join is the default');
        assert.deepStrictEqual(config.core.refill, {
            enabled: true,
            block: 'minecraft:repeating_command_block',
            mode: 'replace',
            intervalMs: 1000,
            spamMs: 150,
            auto: false,
            item: true,
            miniName: null,
            // The example is tuned by hand, so what it sets wins: the rest of the
            // refill settings are the defaults.
            ...example.core.refill,
            chatFallback: true
        });
        assert.strictEqual(config.core.refill.miniName, null, 'the cube is filled unnamed');
        // Addresses come from /seen only; whois is kept for the identity fields.
        assert.match(config.alts.lookupCommand, /^seen /, 'seen is the lookup command');
        assert.doesNotMatch(config.alts.fallbackCommand, /whois/i);
        assert.match(config.alts.detailCommand, /^whois /, 'whois is only the detail command');
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
        assert.strictEqual(event.real, true, 'a player chat packet is real chat');

        // Anything printed by the server is free-form and cannot be trusted to
        // come from the player it claims to be.
        const forged = chatEventFromPacket('system_chat', { content: { text: '<Steve> |>help' } });
        assert.strictEqual(forged.verified, false);
        assert.strictEqual(forged.real, false, 'tellraw output is not a chat packet');
        assert.deepStrictEqual(parseChatLine(forged.line), { username: 'Steve', message: '|>help' });

        // The old chat packet predates signing but is still the server's chat
        // packet, so a rank works there; only printed text is excluded.
        const legacy = chatEventFromPacket('chat', { message: JSON.stringify({ text: '<Steve> |>help' }) });
        assert.strictEqual(legacy.real, true);
        assert.strictEqual(chatEventFromPacket('profileless_chat', { content: { text: '<Steve> |>help' } }).real, false);
    });

    // --- store, permissions, bot -------------------------------------------
    const store = new Store(':memory:').open();
    const config = loadConfig(examplePath);
    // The shipped config is a live one: these tests pin the parts they depend on
    // instead of reading whatever the example happens to hold today.
    config.bot.prefixes = ['v:'];
    config.bot.inGamePrefixes = true;
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

    await check('the owner list in config is what grants owner', () => {
        config.permissions.owner = ['VojtaV12'];
        assert.strictEqual(permissions.levelFor({ name: 'VojtaV12' }), LEVEL.OWNER);
        assert.strictEqual(permissions.levelFor({ name: 'vojtav12' }), LEVEL.OWNER, 'names are case-insensitive');
        assert.strictEqual(permissions.levelFor({ name: 'NotVojtaV12' }), LEVEL.PUBLIC);

        // Ranks come only from config and the database, never from code.
        config.permissions.owner = [];
        assert.strictEqual(permissions.levelFor({ name: 'VojtaV12' }), LEVEL.PUBLIC);
        config.permissions.owner = ['VojtaV12'];

        const shipped = loadConfig(examplePath).permissions;
        // The example only grants what its own lists name; a rank never comes
        // from code. The lists themselves are the config's business.
        assert.ok(Array.isArray(shipped.owner), 'the example ships an owner list');
        assert.ok(Array.isArray(shipped.admin), 'the example ships an admin list');
        assert.ok(Array.isArray(shipped.trusted), 'the example ships a trusted list');
        assert.ok(!shipped.owner.includes('NotVojtaV12'));
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

    await check('the chat prefix is styled and per server wins', () => {
        // The example config ships the chat tag off, so nothing is sent.
        assert.strictEqual(config.bot.prefixEnabled, false);
        assert.strictEqual(bot.tagPrefix(), null);

        config.bot.prefixEnabled = true;
        assert.strictEqual(bot.tagPrefix(), '&a[prefix: v\\]');

        const perServer = new Bot({
            server: {
                id: 'tag',
                host: '127.0.0.1',
                port: 1,
                username: 'vbot',
                auth: 'offline',
                prefix: '&b[other]'
            },
            config,
            store,
            permissions,
            registry: { dispatch: async () => {} },
            logger
        });
        assert.strictEqual(perServer.tagPrefix(), '&b[other]');

        // The tag is set with /prefix, not to be confused with the command
        // prefixes the bot listens for.
        const sent = [];
        const tagged = new Bot({
            server: { id: 'tag2', host: '127.0.0.1', port: 1, username: 'vbot', auth: 'offline' },
            config,
            store,
            permissions,
            registry: { dispatch: async () => {} },
            logger
        });
        tagged.state = 'ready';
        // The prefix is set outside the core, so it goes out as chat directly.
        tagged.sendChat = message => (sent.push(message), true);
        tagged.applyPrefixTag();
        return new Promise(resolve => setTimeout(() => {
            assert.deepStrictEqual(sent, ['/prefix &a[prefix: v\\]']);
            config.bot.prefixEnabled = false;
            resolve();
        }, 1400));
    });

    await check('core write confirmations are swallowed', () => {
        const coreBot = {
            position: { x: 0, y: 64, z: 0 },
            chat: () => true,
            write: () => {},
            log: logger
        };
        const core = new Core({
            bot: coreBot,
            config: { enabled: true, area: { size: 16, y: 64 }, refill: { enabled: true } },
            logger
        });

        assert.strictEqual(core.noteMessage('Command set: whois 9Pon4Inkr7Kn'), true);
        assert.strictEqual(core.noteMessage('advMode.setCommand.successwhois 9Pon4Inkr7Kn'), true);
        assert.strictEqual(core.noteMessage('Changed the block at 0, 64, 0'), true);
        assert.strictEqual(core.noteMessage('Successfully filled 8 block(s)'), true);
        assert.strictEqual(core.noteMessage('Alex: hello'), false);
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
        // The mini core has its own check; what it is handed is what matters here.
        const handed = [];
        core.fillItem = {
            usable: true,
            run: (...commands) => (handed.push(...commands.flat()), { x: 0, y: 63, z: 0 }),
            destroy: () => {}
        };

        assert.strictEqual(core.reset(), true);
        assert.deepStrictEqual(core.origin, { x: 32, y: 64, z: -16 });
        assert.deepStrictEqual(core.bounds, { x: 47, y: 79, z: -1 });

        // The level comes from area.y alone: the area is filled at -30 however
        // high above it the bot stands.
        const deep = new Core({
            bot: coreBot,
            config: { enabled: true, area: { size: 16, y: -30 }, refill: { enabled: true } },
            logger
        });
        assert.strictEqual(deep.reset(), true);
        assert.deepStrictEqual(deep.origin, { x: 32, y: -30, z: -16 });
        assert.deepStrictEqual(deep.bounds, { x: 47, y: -15, z: -1 });
        deep.destroy();

        core.refill('test');
        assert.strictEqual(handed[0], 'fill 32 64 -16 47 79 -1 minecraft:repeating_command_block replace');
        assert.deepStrictEqual(sent, [], 'a fill never goes out as chat');

        const first = core.run('say hello');
        const second = core.run('/gamemode creative');
        assert.deepStrictEqual(first, { x: 32, y: 64, z: -16 });
        assert.notDeepStrictEqual(second, first, 'commands must use different blocks');
        // The command is one update_command_block write into a core block that is
        // already standing: no setblock, and the mini core only ever saw the fill.
        assert.strictEqual(handed.length, 1, 'the mini core only ran the fill');
        assert.deepStrictEqual(writes.map(write => write.name),
            ['update_command_block', 'update_command_block']);
        assert.deepStrictEqual(writes[0].payload,
            { location: first, command: 'say hello', mode: 1, flags: 0b101 });
        assert.deepStrictEqual(writes[1].payload,
            { location: second, command: 'gamemode creative', mode: 1, flags: 0b101 });

        // Our own writes must not look like damage, and neither may the fill.
        assert.strictEqual(core.onBlockChange({ location: first }), false);
        assert.strictEqual(core.onBlockChange({ location: { x: 40, y: 70, z: -10 } }), false, 'the fill is not damage');

        // Once the fill has landed, a real block change inside the core is damage.
        core.refilling = false;
        core.graceUntil = 0;
        core.lastRefillAt = 0;
        core.ready = true;
        core.markAllAlive();
        assert.strictEqual(core.onBlockChange({ location: { x: 40, y: 70, z: -10 } }), true);
        assert.strictEqual(core.blocks.get('40:70:-10'), false);
        core.destroy();
    });

    await check('a command refills the core through the mini core once it has run', async () => {
        const handed = [];
        const sent = [];
        const refillBot = {
            position: { x: 35, y: 70, z: -3 },
            chat: command => (sent.push(command), true),
            write: () => true,
            log: logger
        };
        const core = new Core({
            bot: refillBot,
            config: { enabled: true, area: { size: 16, y: 64 }, refill: { enabled: true } },
            logger
        });
        // The mini core has its own check; what it is handed is what matters here.
        core.fillItem = {
            usable: true,
            run: (...commands) => (handed.push(...commands.flat()), { x: 0, y: 63, z: 0 }),
            destroy: () => {}
        };
        const fills = () => handed.filter(text => text.startsWith('fill ')).length;
        assert.strictEqual(core.reset(), true);
        core.refill('test');
        assert.strictEqual(fills(), 1);
        const at = handed.length;
        // Let that fill settle, then as if it had been a while ago: the refill
        // after a command is not the one the damage interval holds back.
        await new Promise(resolve => setTimeout(resolve, 300));
        core.lastRefillAt = 0;

        assert.ok(core.run('say hello'), 'the command went in');
        assert.strictEqual(fills(), 1, 'the block has to run before the area is filled again');
        core.run('say again');
        await new Promise(resolve => setTimeout(resolve, 1200));

        assert.strictEqual(fills(), 2, 'one refill for both commands');
        assert.strictEqual(core.afterRunTimer, null, 'nothing left pending');
        const fill = handed.slice(at).filter(text => text.startsWith('fill '))[0];
        assert.ok(fill.startsWith('fill '), 'the refill itself goes through the mini core');
        assert.deepStrictEqual(sent, [], 'a refill never goes out as chat');

        // A command whose output is read waits for that output before the refill,
        // or the fresh command would be in the block before the query could answer.
        core.lastRefillAt = 0;
        const before = fills();
        const tracked = core.runTracked('list', { delay: 10, timeout: 80 });
        assert.strictEqual(core.afterRunTimer, null, 'the timed refill is held back for the query');
        await tracked;
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.strictEqual(fills(), before + 1, 'refilled once the output was read');

        core.destroy();
        assert.strictEqual(core.afterRunTimer, null, 'a stopped core refills nothing');
    });

    await check('a filled core runs a burst of commands one packet each', () => {
        const writes = [];
        const burstBot = {
            position: { x: 35, y: 70, z: -3 },
            chat: () => true,
            write: (name, payload) => (writes.push({ name, payload }), true),
            log: logger
        };
        const core = new Core({
            bot: burstBot,
            // A burst this wide is what the config asks for; the default burst is
            // smaller on purpose, so the pacing is exercised by its own check.
            config: {
                enabled: true,
                area: { size: 16, y: 64 },
                refill: { enabled: true, writeBurst: 64 }
            },
            logger
        });
        const handed = [];
        core.fillItem = {
            usable: true,
            run: (...commands) => (handed.push(...commands.flat()), { x: 0, y: 63, z: 0 }),
            destroy: () => {}
        };
        assert.strictEqual(core.reset(), true);
        core.everReady = true;
        core.markAllAlive();

        // What `filter` does: a pile of commands with no room to wait between them.
        const cells = [];
        for (let i = 0; i < 40; i++) cells.push(core.run(`jumpscare bob ${i}`));

        assert.strictEqual(new Set(cells.map(cell => `${cell.x}:${cell.y}:${cell.z}`)).size, 40,
            'every command gets its own block');
        assert.strictEqual(writes.length, 40, 'one packet per command, nothing else');
        assert.ok(writes.every(write => write.name === 'update_command_block'));
        assert.deepStrictEqual(handed, [], 'the mini core is not in the middle of a burst');
        assert.deepStrictEqual(writes[0].payload, {
            location: cells[0], command: 'jumpscare bob 0', mode: 1, flags: 0b101
        });

        core.destroy();
    });

    await check('commands go into a core block, never into the mini core', () => {
        const writes = [];
        const miniBot = {
            position: { x: 35, y: 70, z: -3 },
            chat: () => true,
            write: (name, payload) => (writes.push({ name, payload }), true),
            log: logger
        };
        const core = new Core({
            bot: miniBot,
            config: { enabled: true, area: { size: 4, y: 64 }, refill: { enabled: true } },
            logger
        });
        const handed = [];
        core.fillItem = {
            usable: true,
            standing: true,
            run: (...commands) => {
                handed.push(...commands.flat());
                return { x: 36, y: 73, z: -2 };
            },
            destroy: () => {}
        };
        core.reset();
        core.everReady = true;
        core.markAllAlive();

        const cell = core.run('say hi');
        assert.ok(cell, 'a block of the area takes the command');
        assert.deepStrictEqual(handed, [], 'the mini core is never handed a command');
        assert.strictEqual(writes.length, 1, 'one packet, no placement');
        assert.strictEqual(writes[0].name, 'update_command_block');
        assert.deepStrictEqual(writes[0].payload, { location: cell, command: 'say hi', mode: 1, flags: 0b101 });

        core.destroy();
    });

    await check('filter fills the whole core with its punishment burst', async () => {
        const { Filter } = require('../src/filter');
        const { targetedKick } = require('../src/crash');
        const sent = [];
        const player = { name: 'steve', uuid: 'uuid-steve', ip: '10.0.0.9' };
        const filterBot = {
            id: 'filter-test',
            server: { username: 'vbot' },
            online: new Map([['steve', player]]),
            position: { x: 0, y: 64, z: 0 },
            core: {
                volume: 729,
                run: command => (sent.push(String(command)), { x: 0, y: 64, z: 0 })
            },
            store: { ipsFor: () => [] }
        };
        const filter = new Filter({ bot: filterBot, storePath: 'unused.json', logger });
        // The store is not what this check is about.
        filter.getServerData = () => ({ enabled: true, players: ['steve'], uuids: [], ips: [], regex: null, mutes: [] });
        filter.shouldFilter = () => true;

        assert.strictEqual(filter.punish(player), true);
        assert.ok(filter.punishTimers.get('uuid-steve')?.kickTimer,
            'the kick repeats while the player stays online');
        filter.destroy();

        // The mute is asked for once, not on a timer: asking again only repeats
        // "already muted" in the server's log.
        assert.strictEqual(sent.filter(command => command === 'mute steve filtered').length, 1,
            'one mute');

        // The kick is one packet for this player alone, off the burst: a
        // repeating one would only be written for a client that is already gone.
        const kick = targetedKick('steve');
        assert.strictEqual(sent.filter(command => command === kick).length, 1, 'one targeted kick');
        assert.notStrictEqual(targetedKick('alex'), kick, 'the kick names its target');

        // One command per block written into, so every one of them is running
        // something on the next tick instead of a fixed handful in a loop - but
        // the burst is capped, never one packet per block of a 16^3 core: the
        // cursor walks the area, and the write rate is what starved the loop.
        const burst = sent.filter(command =>
            command !== kick && !/^(tellraw|mute|title) /.test(command));
        assert.strictEqual(burst.length, 128, 'the burst is capped, not one write per block');
        assert.strictEqual(new Set(burst).size >= 3, true, 'the whole punishment set is in there');
        assert.ok(burst.filter(command => command === 'jumpscare steve').length >= 90,
            'the rest of the burst is jumpscares');
        assert.ok(burst.some(command => command === 'deop steve'), 'and the rest of the punishments');
        assert.ok(burst.some(command => command === 'gamemode spectator steve'));

        // A smaller core sends a smaller burst, never more than it has blocks.
        const small = [];
        filterBot.core = { volume: 27, run: command => (small.push(String(command)), { x: 0, y: 64, z: 0 }) };
        const smallFilter = new Filter({ bot: filterBot, storePath: 'unused.json', logger });
        smallFilter.getServerData = filter.getServerData;
        smallFilter.shouldFilter = () => true;
        smallFilter.punish(player);
        smallFilter.destroy();
        assert.strictEqual(
            small.filter(command =>
                command !== kick && !/^(tellraw|mute|title) /.test(command)).length,
            27,
            'as wide as the core'
        );
    });

    await check('the whitelist punishes once per player and mutes once', async () => {
        const { Whitelist } = require('../src/whitelist');
        const { targetedKick } = require('../src/crash');
        const sent = [];
        const player = { name: 'steve', uuid: 'uuid-steve', ip: '10.0.0.9' };
        const bot = {
            id: 'whitelist-test',
            server: { username: 'vbot' },
            online: new Map([['steve', player]]),
            position: { x: 0, y: 64, z: 0 },
            core: { volume: 27, run: command => (sent.push(String(command)), { x: 0, y: 64, z: 0 }) },
            store: { ipsFor: () => [] }
        };
        const whitelist = new Whitelist({ bot, storePath: 'unused.json', logger });
        whitelist.getServerData = () => ({ enabled: true, players: [], uuids: [], ips: [] });

        assert.strictEqual(whitelist.punish(player), true);
        assert.strictEqual(whitelist.punish(player), true, 'the same player is not punished twice');
        whitelist.destroy();

        assert.strictEqual(sent.filter(command => command.startsWith('mute ')).length, 1,
            'one mute, not one every few seconds');
        assert.strictEqual(sent.filter(command => command === 'mute steve whitelist').length, 1);
        assert.ok(sent.some(command => command.includes('end_portal')), 'the whitelist punishment set');
        assert.strictEqual(
            sent.filter(command => command === targetedKick('steve')).length,
            1,
            'one targeted kick, and only for the player who is not whitelisted'
        );
    });

    await check('filter add-ip takes a name and adds every address it has, --all on every server', async () => {
        const { Filter } = require('../src/filter');
        const command = require('../src/commands/filter');
        const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-filter-')), 'filter.json');
        const player = { name: 'steve', uuid: 'uuid-steve', ip: '10.0.0.9' };
        const bot = {
            id: 'alpha',
            server: { username: 'vbot' },
            online: new Map([['steve', player]]),
            core: { volume: 1, run: () => true },
            config: { minecraft: { servers: [{ id: 'alpha' }, { id: 'beta' }] } },
            store: { ipsFor: () => [{ ip: '10.0.0.9' }, { ip: '10.0.0.10' }] },
            ipLookup: { ipFor: () => '10.0.0.11' }
        };
        const filter = new Filter({ bot, storePath, logger });
        filter.sweep = () => true;

        const replies = [];
        await command.execute({
            args: ['add-ip', 'steve', '--all'],
            prefix: 'v\\',
            bot: { filter },
            reply: text => (replies.push(text), text)
        });

        assert.ok(/Added 3 IP\(s\) for steve/.test(replies[0]), 'the name resolves to every address');
        const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        const expected = ['10.0.0.10', '10.0.0.11', '10.0.0.9'];
        assert.deepStrictEqual(saved.alpha.ips.slice().sort(), expected, 'this server');
        assert.deepStrictEqual(saved.beta.ips.slice().sort(), expected, '--all reaches every configured server');
    });

    await check('kick takes a name, an address, a uuid or a regex', async () => {
        const kick = require('../src/commands/kick');
        const sent = [];
        const replies = [];
        const steve = { name: 'steve', uuid: '11111111-1111-1111-1111-111111111111', ip: '10.0.0.9' };
        const alex = { name: 'alex', uuid: '22222222-2222-2222-2222-222222222222', ip: '10.0.0.10' };
        const bot = {
            server: { username: 'vbot' },
            online: new Map([
                ['steve', steve],
                ['alex', alex],
                ['vbot', { name: 'vbot' }]
            ]),
            core: {},
            filter: { playerIps: p => new Set([p.ip]) }
        };
        const ctxFor = raw => ({
            args: [raw],
            prefix: 'v\\',
            bot,
            run: command => (sent.push(command), true),
            reply: text => (replies.push(text), text)
        });

        // The repeat is a real timer: stop it between cases so the next case
        // counts only its own packets.
        const stopLoops = () => {
            for (const timer of bot.kickLoops?.values() ?? []) clearInterval(timer);
            bot.kickLoops?.clear();
        };

        assert.strictEqual(kick.level, 'trusted', 'trusted and above only');

        await kick.execute(ctxFor('steve'));
        assert.strictEqual(sent.length, 2, 'the first title and subtitle go out with the command');
        assert.ok(sent[0].includes('steve'), 'aimed at the named player');
        assert.ok(sent[1].includes('steve') && sent[1].includes('subtitle'), 'with their subtitle');
        assert.strictEqual(bot.kickLoops.size, 1, 'and it keeps going from there');

        stopLoops();
        sent.length = 0;
        await kick.execute(ctxFor('10.0.0.10'));
        assert.ok(sent[0].includes('alex'), 'an address finds its player');

        stopLoops();
        sent.length = 0;
        await kick.execute(ctxFor('22222222-2222-2222-2222-222222222222'));
        assert.ok(sent[0].includes('alex'), 'a uuid finds its player');

        stopLoops();
        sent.length = 0;
        await kick.execute(ctxFor('re:^st'));
        assert.strictEqual(sent.length, 2, 'a regex can match one');
        assert.ok(sent[0].includes('steve'));

        stopLoops();
        sent.length = 0;
        await kick.execute(ctxFor('vbot'));
        assert.strictEqual(sent.length, 0, 'the bot never kicks itself');
        stopLoops();
    });

    await check('the mini core is taken away in one fill of air', async () => {
        const { MiniCore } = require('../src/minicore');
        const commands = [];
        const bot = {
            position: { x: 0, y: 64, z: 0 },
            write: (name, packet) => {
                commands.push(packet.command);
                return true;
            },
            core: { chatRun: command => commands.push(`chat:${command}`) }
        };
        const mini = new MiniCore({ bot, logger, config: {} });
        mini.confirmAll();

        assert.strictEqual(mini.clear(), true);
        assert.ok(
            commands.some(command => /^fill -?\d+ -?\d+ -?\d+ -?\d+ -?\d+ -?\d+ minecraft:air$/.test(command)),
            `the cube is filled with air: ${JSON.stringify(commands)}`
        );
    });

    await check('stop clears both cores, then ends the process with the stop code', async () => {
        const stop = require('../src/commands/stop');

        const cleared = [];
        const replies = [];
        const ctx = {
            args: [],
            prefix: 'v\\',
            reply: text => replies.push(text),
            bot: {
                core: {
                    clear: () => (cleared.push('core'), true),
                    fillItem: { clear: () => (cleared.push('mini core'), true) }
                }
            }
        };

        const realExit = process.exit;
        let code = null;
        process.exit = value => { code = value; };
        try {
            await stop.execute(ctx);
            await new Promise(resolve => setTimeout(resolve, 1700));
        } finally {
            process.exit = realExit;
        }

        assert.strictEqual(stop.level, 'owner', 'the owner only');
        assert.deepStrictEqual(cleared, ['mini core', 'core'], 'the cube first, then the area');
        assert.strictEqual(code, 42, 'the code the workflow reads as stop');
        assert.ok(replies.length, 'and it says so');
    });

    await check('a name opens its addresses and a uuid copies or inserts itself', async () => {
        const list = require('../src/commands/list');
        const uuid = '0f9d8c2a-1111-2222-3333-444455556666';

        let parts = null;
        const ctx = {
            args: [],
            prefix: 'v\\',
            reply: value => { parts = value; },
            bot: {
                online: new Map([['steve', { name: 'steve', uuid }]]),
                ipLookup: { ipFor: () => '10.0.0.9' },
                versions: { versionFor: name => (name === 'steve' ? { version: '26.3', at: Date.now() } : null) }
            }
        };

        await list.execute(ctx);

        const name = parts.find(part => part && part.text === 'steve');
        assert.deepStrictEqual(name.click, { action: 'suggest_command', value: 'v\\alts steve' },
            'clicking the name runs alts for it');
        assert.match(name.hover.text, /version: 26\.3/, 'the hover carries the last known version');

        const id = parts.find(part => part && part.text === uuid);
        assert.deepStrictEqual(id.click, { action: 'copy_to_clipboard', value: uuid }, 'clicking the uuid copies it');
        assert.strictEqual(id.insertion, uuid, 'shift-clicking puts it in the chat box');
    });

    await check('a punished player keeps a full screen title saying why', async () => {
        const { Filter } = require('../src/filter');
        const { Whitelist } = require('../src/whitelist');
        const sent = [];
        const player = { name: 'steve', uuid: 'uuid-steve', ip: '10.0.0.9' };
        const bot = {
            id: 'title-test',
            server: { username: 'vbot' },
            online: new Map([['steve', player]]),
            position: { x: 0, y: 64, z: 0 },
            core: { volume: 27, run: command => (sent.push(String(command)), { x: 0, y: 64, z: 0 }) },
            store: { ipsFor: () => [] }
        };
        const filter = new Filter({ bot, storePath: 'unused.json', logger });
        filter.getServerData = () => ({
            enabled: true,
            players: ['steve'],
            uuids: [],
            ips: [],
            regex: null,
            mutes: [],
            reasons: { steve: 'spam bots' }
        });
        assert.strictEqual(filter.reasonFor(player), 'spam bots', 'the reason stored for the name');
        assert.strictEqual(filter.reasonFor({ name: 'nobody' }), 'filtered', 'and a default for the rest');
        assert.strictEqual(filter.punish(player), true);

        assert.ok(sent.includes('title steve times 0 2147483647 0'), 'a stay as long as ticks go');
        assert.ok(sent.includes('title steve title {"text":"filtered"}'), 'the title');
        assert.ok(sent.includes('title steve subtitle {"text":"reason: spam bots"}'), 'the reason under it');
        assert.ok(sent.includes('mute steve spam bots'), 'and the mute carries the reason');

        // Off the filter: the title is taken down again.
        filter.shouldFilter = () => false;
        await new Promise(resolve => setTimeout(resolve, 160));
        filter.destroy();
        assert.ok(sent.includes('title steve clear'), 'cleared when the punishment ends');
        assert.ok(sent.includes('title steve reset'));

        // The whitelist has its own title, without a reason.
        const wSent = [];
        const wBot = { ...bot, core: { volume: 27, run: command => (wSent.push(String(command)), { x: 0, y: 64, z: 0 }) } };
        const whitelist = new Whitelist({ bot: wBot, storePath: 'unused.json', logger });
        whitelist.getServerData = () => ({ enabled: true, players: [], uuids: [], ips: [] });
        whitelist.punish(player);
        whitelist.destroy();
        assert.ok(wSent.includes('title steve title {"text":"whitelist enabled"}'), 'the whitelist title');
        assert.strictEqual(wSent.some(command => command.startsWith('title steve subtitle')), false,
            'no reason to give');
    });

    await check('refill spam refills through the blocks and stops itself', async () => {
        const sent = [];
        const writes = [];
        const spamBot = {
            position: { x: 35, y: 70, z: -3 },
            chat: command => sent.push(command),
            write: (name, payload) => writes.push(payload),
            log: logger
        };
        const core = new Core({
            bot: spamBot,
            config: { enabled: true, area: { size: 9, y: 64 }, refill: { enabled: true, spamMs: 40 } },
            logger
        });
        assert.strictEqual(core.reset(), true);
        writes.length = 0;
        sent.length = 0;

        assert.strictEqual(core.startSpam({ durationMs: 150 }), true);
        assert.strictEqual(core.startSpam({ durationMs: 150 }), false, 'one burst at a time');
        assert.strictEqual(core.spamStatus().running, true);

        await new Promise(resolve => setTimeout(resolve, 260));
        const status = core.spamStatus();
        core.destroy();

        assert.strictEqual(status.running, false, 'the burst ends by itself');
        assert.ok(writes.length >= 2, `expected a few fills, got ${writes.length}`);
        assert.ok(
            writes.every(write => write.command.startsWith('fill ')),
            'every write is the fill'
        );
        assert.deepStrictEqual(sent, [], 'spam never goes through chat');
    });

    const refillCommandCheck = async () => {
        const spam = { started: null, running: false, intervalMs: 1 };
        const botCore = {
            startSpam: options => {
                if (spam.running) return false;
                spam.started = options;
                spam.running = true;
                return true;
            },
            stopSpam: () => {
                const was = spam.running;
                spam.running = false;
                return was;
            },
            spamStatus: () => (spam.running
                ? { running: true, intervalMs: 1, count: 3, leftMs: null }
                : { running: false, intervalMs: 1 })
        };
        const spamBot = { ...fakeBot, core: botCore };

        // On is a toggle: no duration, it keeps going until it is switched off.
        sent.length = 0;
        await registry.dispatch({ bot: spamBot, parsed: parseChatLine('<VojtaV12> v:refill on') });
        assert.strictEqual(spam.started.durationMs, undefined);
        assert.match(decodeReply(sent[0]), /Refilling every 1ms until .*refill off/);

        sent.length = 0;
        await registry.dispatch({ bot: spamBot, parsed: parseChatLine('<VojtaV12> v:refill status') });
        assert.strictEqual(decodeReply(sent[0]), 'Refilling every 1ms, 3 fill(s) so far, until stopped.');

        sent.length = 0;
        await registry.dispatch({ bot: spamBot, parsed: parseChatLine('<VojtaV12> v:refill off') });
        assert.strictEqual(spam.running, false);
        assert.strictEqual(decodeReply(sent[0]), 'Refilling stopped.');

        // Switched off twice is not an error, just nothing to stop.
        sent.length = 0;
        await registry.dispatch({ bot: spamBot, parsed: parseChatLine('<VojtaV12> v:refill off') });
        assert.strictEqual(decodeReply(sent[0]), 'Refilling was not running.');
    };
    await check('core blocks can be named from config', () => {
        const named = [];
        const fake = version => ({
            client: { version },
            position: { x: 0, y: 70, z: 0 },
            chat: command => named.push(command),
            write: () => true,
            log: logger
        });
        const nameConfig = {
            enabled: true,
            name: '{"text":"vbot","color":"green"}',
            area: { size: 9, y: 64 },
            // The item path is checked on its own; this is about the fill text.
            refill: { enabled: true, item: false }
        };

        // 1.21.5+ stores the name as an inline component, not a quoted JSON string.
        const modern = new Core({ bot: fake('1.21.5'), config: nameConfig, logger });
        modern.reset();
        assert.strictEqual(
            modern.fillCommand(),
            "fill 0 64 0 8 72 8 minecraft:repeating_command_block{CustomName:{text:'vbot',color:'green'}} replace"
        );
        assert.match(modern.status(), /name \{"text"/);

        const legacy = new Core({ bot: fake('1.20.4'), config: nameConfig, logger });
        legacy.reset();
        assert.strictEqual(
            legacy.fillCommand(),
            'fill 0 64 0 8 72 8 minecraft:repeating_command_block{CustomName:\'{"text":"vbot","color":"green"}\'} replace'
        );

        // Without a name the fill stays plain.
        const plainCore = new Core({
            bot: fake('1.21.5'),
            config: { enabled: true, area: { size: 9, y: 64 }, refill: { enabled: true, item: false } },
            logger
        });
        plainCore.reset();
        assert.strictEqual(plainCore.fillCommand(), 'fill 0 64 0 8 72 8 minecraft:repeating_command_block replace');
        assert.deepStrictEqual(named, [], 'fills never go out as chat');

        modern.destroy();
        legacy.destroy();
        plainCore.destroy();
    });

    await check('the mini core is one fill, size x size x size, above the bot', () => {
        const { MiniCore } = require('../src/minicore');
        const writes = [];
        const miniBot = {
            client: { version: '1.21.4' },
            position: { x: 10.7, y: 64, z: -3.2 },
            write: (name, payload) => (writes.push({ name, payload }), true)
        };

        const mini = new MiniCore({ bot: miniBot, logger, config: {} });
        assert.strictEqual(mini.side, 2, 'two on a side');
        assert.strictEqual(mini.count, 8, 'two by two by two, just enough to hold a refill');
        // One fill, over the bot's head: no item, no slot packet, no placement.
        assert.strictEqual(mini.fillCommand(), 'fill 9 66 -5 10 67 -4 repeating_command_block');
        assert.deepStrictEqual(writes, [], 'the cube is never a packet of its own');
        assert.strictEqual(mini.standing, false, 'nothing counts until the server shows a block');
        assert.strictEqual(mini.run('say hi'), null, 'nothing is written into a cube that is not there');

        // The side is the size, and a config that still asks for a number of
        // blocks gets the cube root of it.
        assert.strictEqual(new MiniCore({ bot: miniBot, logger, config: { miniSize: 5 } }).count, 125);
        const legacy = new MiniCore({ bot: miniBot, logger, config: { itemCount: 64 } });
        assert.strictEqual(legacy.side, 4, '64 blocks is a cube on a side of four');
        assert.strictEqual(new MiniCore({ bot: miniBot, logger, config: { miniSize: 99 } }).side, 16,
            'a silly size is capped');

        mini.destroy();
    });

    await check('a mini core cell counts only once the server shows a command block there', () => {
        const { MiniCore } = require('../src/minicore');
        const writes = [];
        const miniBot = {
            client: { version: '1.21.4' },
            position: { x: 10.7, y: 64, z: -3.2 },
            write: (name, payload) => (writes.push({ name, payload }), true)
        };
        const CMD_STATE = require('minecraft-data')('1.21.4').blocksByName.command_block.defaultState;
        const mini = new MiniCore({ bot: miniBot, logger, config: {} });

        mini.fillCommand();
        // Air says the fill did not land, and a floor says it landed somewhere
        // else: neither is the bot's block.
        assert.strictEqual(mini.noteBlockChange({ location: { x: 9, y: 66, z: -5 }, type: 0 }), false);
        assert.strictEqual(mini.standing, false);
        // The block update that comes with the fill is the answer.
        assert.strictEqual(mini.noteBlockChange({ location: { x: 9, y: 66, z: -5 }, type: CMD_STATE }), false);
        assert.strictEqual(mini.standing, true);
        assert.deepStrictEqual(mini.cells(), [{ x: 9, y: 66, z: -5 }]);

        // A block the server has not shown is never written into.
        const cell = mini.run('say hi');
        assert.deepStrictEqual(cell, { x: 9, y: 66, z: -5 });
        assert.strictEqual(writes.length, 1);
        assert.strictEqual(writes[0].name, 'update_command_block');
        assert.strictEqual(writes[0].payload.command, 'say hi');

        // A cube that the server never answers is asked for again later, not
        // filled over and over.
        const refused = new MiniCore({ bot: miniBot, logger, config: {} });
        assert.ok(refused.fillCommand());
        assert.strictEqual(refused.fillCommand(), null, 'the fill is already out');
        refused.refused();
        assert.strictEqual(refused.fillCommand(), null, 'a cube that did not land is left alone');

        mini.destroy();
        refused.destroy();
    });

    await check('the mini core holds refills, one block at a time', () => {
        const { MiniCore } = require('../src/minicore');
        const writes = [];
        const miniBot = {
            client: { version: '1.21.4' },
            position: { x: 10.7, y: 64, z: -3.2 },
            write: (name, payload) => (writes.push({ name, payload }), true)
        };
        const CMD_STATE = require('minecraft-data')('1.21.4').blocksByName.command_block.defaultState;
        const mini = new MiniCore({ bot: miniBot, logger, config: {} });
        const box = mini.boxFor(mini.feet());

        // The fill lands in one go: every cell is shown at once.
        for (const cell of box.cells) mini.noteBlockChange({ location: cell, type: CMD_STATE });
        assert.strictEqual(mini.cells().length, 8, 'the whole cube stands');
        assert.strictEqual(mini.ready, 8);

        // One command per block, in turn: 8 commands take 8 different cells, and
        // not one of them is a placement.
        const used = new Set();
        for (let i = 0; i < 8; i++) {
            const cell = mini.run(`say ${i}`);
            assert.ok(cell, 'a block took the command');
            used.add(`${cell.x}:${cell.y}:${cell.z}`);
        }
        assert.strictEqual(used.size, 8, 'every block of the cube is used once');
        assert.strictEqual(writes.filter(write => write.name === 'block_place').length, 0,
            'nothing is placed by hand');

        // A block that is still running the command before is passed over.
        writes.length = 0;
        const before = mini.turn;
        mini.write(box.cells[before], 'say long');
        mini.slots.get(`${box.cells[before].x}:${box.cells[before].y}:${box.cells[before].z}`).busyUntil = Date.now() + 60000;
        const next = mini.run('say next');
        assert.notDeepStrictEqual(next, box.cells[before], 'a busy block is not overwritten');

        mini.destroy();
    });

    await check('a mini core block that goes is filled again, not written into', () => {
        const { MiniCore } = require('../src/minicore');
        const writes = [];
        const miniBot = {
            client: { version: '1.21.4' },
            position: { x: 10.7, y: 64, z: -3.2 },
            write: (name, payload) => (writes.push({ name, payload }), true)
        };
        const CMD_STATE = require('minecraft-data')('1.21.4').blocksByName.command_block.defaultState;
        const mini = new MiniCore({ bot: miniBot, logger, config: {} });
        const box = mini.boxFor(mini.feet());
        for (const cell of box.cells) mini.noteBlockChange({ location: cell, type: CMD_STATE });

        // Air at one of its cells: that block is gone, and the cube is filled again
        // instead of a command being written into nothing.
        const first = mini.cells()[0];
        assert.strictEqual(mini.noteBlockChange({ location: first, type: 0 }), true, 'the block is gone');
        assert.strictEqual(mini.cells().length, 7);
        assert.strictEqual(mini.fillCommand(), 'fill 9 66 -5 10 67 -4 repeating_command_block');

        // A block replaced by something else is gone too.
        const second = mini.cells()[0];
        const floor = require('minecraft-data')('1.21.4').blocksByName.stone.defaultState;
        assert.strictEqual(mini.noteBlockChange({ location: second, type: floor }), true);
        assert.strictEqual(mini.cells().length, 6);

        // A bulk edit takes all of them with no block update at all.
        assert.strictEqual(mini.goneAll(), 6, 'the whole set is dropped');
        assert.strictEqual(mini.standing, false);

        // A bot that walks away leaves the cube behind and gets a new one.
        miniBot.position = { x: 10.7 + 200, y: 64, z: -3.2 };
        const moved = mini.fillCommand();
        assert.match(moved, /^fill /);
        assert.notStrictEqual(moved, 'fill 9 66 -5 10 67 -4 repeating_command_block');

        mini.destroy();
    });

    await check('the mini core is filled with its own name', () => {
        const { MiniCore } = require('../src/minicore');
        const name = '{"text":"mini core™","color":"green"}';
        const miniBot = {
            client: { version: '26.1' },
            position: { x: 10.7, y: 64, z: -3.2 },
            write: () => true
        };
        const named = new MiniCore({ bot: miniBot, logger, config: { name } });
        assert.strictEqual(named.fillCommand(),
            "fill 9 66 -5 10 67 -4 repeating_command_block{CustomName:{text:'mini core™',color:'green'}}");
        assert.strictEqual(named.name, name);

        // Before 1.21.5 the name is a JSON string, and it goes in quoted.
        const oldBot = { ...miniBot, client: { version: '1.21.4' } };
        const old = new MiniCore({ bot: oldBot, logger, config: { name } });
        assert.strictEqual(old.fillCommand(),
            `fill 9 66 -5 10 67 -4 repeating_command_block{CustomName:'${name}'}`);

        // A cube with no name is filled as the plain block.
        const plain = new MiniCore({ bot: miniBot, logger, config: {} });
        assert.strictEqual(plain.fillCommand(), 'fill 9 66 -5 10 67 -4 repeating_command_block');

        named.destroy();
        old.destroy();
        plain.destroy();
    });

    await check('a mini core with a hole in it is filled again while the rest stands', () => {
        const writes = [];
        const miniBot = {
            client: { version: '1.21.4' },
            position: { x: 10.7, y: 64, z: -3.2 },
            write: (name, payload) => (writes.push({ name, payload }), true),
            chat: () => true
        };
        const core = new Core({
            bot: miniBot,
            config: {
                enabled: true,
                area: { size: 9, y: 64 },
                refill: { enabled: true, miniName: '{"text":"mini core™","color":"green"}' }
            },
            logger
        });
        // The area is beside the bot, so only the cube is under test here.
        core.origin = { x: 0, y: 64, z: 0 };
        core.bounds = { x: 8, y: 72, z: 8 };
        core.ready = true;
        core.everReady = true;
        core.graceUntil = 0;
        core.markAllAlive();

        const mini = core.fillItem;
        assert.strictEqual(mini.name, '{"text":"mini core™","color":"green"}', 'the name comes from the config');
        const CMD_STATE = require('minecraft-data')('1.21.4').blocksByName.command_block.defaultState;
        for (const cell of mini.current().cells) mini.noteBlockChange({ location: { ...cell }, type: CMD_STATE });
        assert.strictEqual(mini.standing, true);
        assert.strictEqual(mini.needsFill(), false, 'a whole cube needs nothing');

        // One block of the cube goes: the rest still stands, and the cube is filled
        // again anyway, instead of waiting for all of it to be gone.
        mini.gone(mini.cells()[0]);
        assert.strictEqual(mini.standing, true, 'the rest of the cube is still there');
        assert.strictEqual(mini.needsFill(), true, 'a cube with a hole is not whole');

        writes.length = 0;
        core.lastRefillAt = 0;
        assert.strictEqual(core.refill('test'), true);
        assert.ok(writes.some(write => write.name === 'update_command_block'
            && /^fill 9 66 -5 10 67 -4 .*mini core/.test(write.payload.command)),
        'the cube is filled again, with its name, from a block that still stands');
        assert.strictEqual(writes.filter(write => write.name === 'block_place').length, 0,
            'nothing is placed by hand');

        core.destroy();
    });

    await check('the core starts once the position is known, however often it is asked', () => {
        const fills = [];
        const startBot = {
            position: null,
            client: { version: '1.21.4' },
            write: () => true,
            sendChat: () => true,
            server: { username: 'vbot' }
        };
        const core = new Core({
            bot: startBot,
            config: {
                enabled: true,
                area: { size: 2, y: 64 },
                // No join teleport here: the start is what is under test.
                joinRtp: false,
                refill: { enabled: true }
            },
            logger
        });
        core.fillItem = {
            usable: true,
            run: (...commands) => (fills.push(...commands.flat()), { x: 0, y: 63, z: 0 }),
            destroy: () => {}
        };

        // No position yet: nothing is filled, and the core waits instead of
        // giving up for the rest of the session.
        core.onReady();
        assert.strictEqual(fills.length, 0, 'nothing is filled without a position');
        assert.strictEqual(core.started, false, 'the core has not started yet');

        // The position packet is what starts it, on a server that was slow.
        startBot.position = { x: 0.5, y: 64, z: 0.5 };
        core.onReady();
        assert.strictEqual(core.started, true, 'the position starts the core');
        assert.match(fills[0], /^fill 0 64 0 1 65 1 /);

        // A later position packet must not fill or teleport a second time.
        core.onReady();
        core.onReady();
        assert.strictEqual(fills.length, 1, 'a second start does nothing');
        core.destroy();
        assert.strictEqual(core.started, false, 'a reconnect starts over');
    });

    await check('selfcare asks for creative when the server never names the gamemode', () => {
        const EventEmitter = require('node:events');
        const { SelfCare } = require('../src/selfcare');
        const sent = [];
        const careBot = new EventEmitter();
        careBot.server = { username: 'vbot' };
        careBot.client = { uuid: '00000000-0000-0000-0000-000000000002', entityId: 8, chat: () => {} };
        careBot.sendChat = command => (sent.push(command), true);
        careBot.core = null;

        const care = new SelfCare({
            bot: careBot,
            config: { commandSpy: false, vanish: false },
            logger
        });
        care.onReady();
        care.opLevel = 1;
        care.gamemode = null;

        care.tick();
        assert.ok(sent.includes('/gamemode creative'), 'creative is asked for without a known gamemode');
        care.tick();
        assert.strictEqual(sent.filter(command => command === '/gamemode creative').length, 1,
            'and not again on the next tick');
        care.destroy();
    });

    await check('the bot core spy reads the commands of command blocks', async () => {
        const EventEmitter = require('node:events');
        const { BotCSpy, readCommand, readType, MAX_CELLS } = require('../src/botcspy');

        const client = new EventEmitter();
        const sent = [];
        const spyBot = {
            client,
            position: { x: 0.5, y: 64, z: 0.5 },
            write: (name, payload) => {
                sent.push(name);
                const nbt = payload.location.x === 0 && payload.location.z === 0
                    ? {
                        type: 'compound',
                        value: {
                            id: { type: 'string', value: 'minecraft:command_block' },
                            Command: { type: 'string', value: '/say hello' },
                            auto: { type: 'byte', value: 1 }
                        }
                    }
                    : null;
                setImmediate(() => client.emit('nbt_query_response', {
                    transactionId: payload.transactionId,
                    nbt
                }));
                return true;
            }
        };

        const spy = new BotCSpy({ bot: spyBot, logger });
        const result = await spy.scan({ from: { x: -1, y: 64, z: -1 }, to: { x: 1, y: 64, z: 1 } });

        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.from, { x: -1, y: 64, z: -1 }, 'the low corner');
        assert.deepStrictEqual(result.to, { x: 1, y: 64, z: 1 }, 'and the high one');
        assert.strictEqual(result.cells, 9, 'a 3x1x3 box');
        assert.strictEqual(result.answered, 9, 'every block is answered');
        assert.strictEqual(result.found.length, 1, 'the one command block is found');
        assert.strictEqual(result.found[0].command, 'say hello', 'the leading slash is dropped');
        assert.strictEqual(result.found[0].auto, true, 'an auto block is marked');
        assert.strictEqual(result.found[0].type, 'impulse', 'and its type is shown');
        assert.ok(sent.every(name => name === 'query_block_nbt'), 'only block queries go out');

        // Corners in either order are the same box, as in fill.
        const reversed = await spy.scan({ from: { x: 1, y: 64, z: 1 }, to: { x: -1, y: 64, z: -1 } });
        assert.strictEqual(reversed.cells, 9, 'the same box the other way round');
        assert.deepStrictEqual(reversed.from, { x: -1, y: 64, z: -1 });
        assert.deepStrictEqual(reversed.to, { x: 1, y: 64, z: 1 });

        // Without corners the box is a core-sized one around the bot.
        const box = spy.boxAt({ x: 10.9, y: 64.2, z: -3.7 });
        assert.deepStrictEqual(box.from, { x: 2, y: 62, z: -12 });
        assert.deepStrictEqual(box.to, { x: 18, y: 66, z: 4 });
        assert.strictEqual(spy.count(box), 17 * 5 * 17);

        // A box no core could fill is refused before a query goes out, and a
        // corner that is not a number is not walked as NaN.
        sent.length = 0;
        const huge = await spy.scan({ from: { x: 0, y: 0, z: 0 }, to: { x: 100, y: 100, z: 100 } });
        assert.strictEqual(huge.ok, false);
        assert.strictEqual(huge.reason, 'too-big');
        assert.ok(huge.cells > MAX_CELLS);
        assert.deepStrictEqual(sent, [], 'nothing is asked about a box that big');

        const nonsense = await spy.scan({ from: { x: 'a', y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 } });
        assert.strictEqual(nonsense.reason, 'bad-box');

        // Plain, untyped NBT reads the same, and an empty command is not a core.
        assert.strictEqual(readCommand({ Command: ' op vbot', auto: 1 }), 'op vbot');
        assert.strictEqual(readCommand({ Command: '   ' }), null);
        assert.strictEqual(readCommand(null), null);

        // All three types carry the same Command; the type is only a label, and
        // each shape - impulse, repeating, chain - is read the same way.
        const shape = (id, extra = {}) => ({
            type: 'compound',
            value: {
                id: { type: 'string', value: id },
                Command: { type: 'string', value: '/say hi' },
                ...extra
            }
        });
        const repeating = shape('minecraft:repeating_command_block', {
            auto: { type: 'byte', value: 1 },
            powered: { type: 'byte', value: 0 }
        });
        const chain = shape('minecraft:chain_command_block', {
            auto: { type: 'byte', value: 1 },
            conditionMet: { type: 'byte', value: 0 },
            facing: { type: 'string', value: 'north' }
        });
        const impulse = shape('minecraft:command_block', {
            auto: { type: 'byte', value: 0 },
            powered: { type: 'byte', value: 0 }
        });
        assert.strictEqual(readCommand(repeating), 'say hi', 'a repeating block is read');
        assert.strictEqual(readCommand(chain), 'say hi', 'a chain block is read');
        assert.strictEqual(readCommand(impulse), 'say hi', 'an impulse block is read');
        assert.strictEqual(readType(repeating), 'repeating');
        assert.strictEqual(readType(chain), 'chain');
        assert.strictEqual(readType(impulse), 'impulse');
        assert.strictEqual(readType(shape('minecraft:command_block')), 'impulse');

        // An answer without an id is still told apart by its fields: only a chain
        // block carries `conditionMet`, and a block that runs itself repeats.
        assert.strictEqual(readType({
            type: 'compound',
            value: { Command: { type: 'string', value: '/say hi' }, conditionMet: { type: 'byte', value: 0 } }
        }), 'chain');
        assert.strictEqual(readType({
            type: 'compound',
            value: { Command: { type: 'string', value: '/say hi' }, auto: { type: 'byte', value: 1 } }
        }), 'repeating');
        assert.strictEqual(readType({
            type: 'compound',
            value: { Command: { type: 'string', value: '/say hi' } }
        }), null, 'a command with no id and no type field is left unlabelled');

        // Watch mode sweeps on its own, and stops when told to.
        let passes = 0;
        spy.watch({ from: { x: 0, y: 64, z: 0 }, to: { x: 0, y: 64, z: 0 }, everyMs: 1000, onScan: () => { passes += 1; } });
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.ok(passes >= 1, 'watch mode sweeps by itself');
        assert.strictEqual(spy.watching, true);
        assert.strictEqual(spy.stop(), true);
        assert.strictEqual(spy.watching, false);
        spy.destroy();
    });

    await check('botcspy reports what it found, and says when nothing answered', async () => {
        const command = require('../src/commands/botcspy');
        assert.strictEqual(command.name, 'botcspy');
        assert.ok(command.aliases.includes('cspy'));

        const result = () => ({
            ok: true,
            cells: 9,
            answered: 9,
            misses: 0,
            from: { x: 0, y: 64, z: 0 },
            to: { x: 2, y: 64, z: 2 },
            found: [{
                command: 'say hello',
                cell: { x: 0, y: 64, z: 0 },
                cells: [{ x: 0, y: 64, z: 0 }],
                count: 1,
                auto: true
            }]
        });

        const replies = [];
        const ctx = {
            args: [],
            bot: {
                position: { x: 0.5, y: 64, z: 0.5 },
                cspy: { scan: async () => result() }
            },
            reply: parts => replies.push(parts),
            logger
        };
        await command.execute(ctx);
        const shown = JSON.stringify(replies[0]);
        assert.match(shown, /say hello/, 'the command is shown');
        assert.match(shown, /0 64 0/, 'with where it is');
        assert.match(shown, /auto/, 'and that it runs itself');

        // Two corners go to the sweep as they were given, like fill.
        let asked = null;
        await command.execute({
            ...ctx,
            args: ['10', '64', '-5', '20', '70', '5'],
            bot: { position: ctx.bot.position, cspy: { scan: async options => { asked = options; return result(); } } }
        });
        assert.deepStrictEqual(asked, { from: { x: 10, y: 64, z: -5 }, to: { x: 20, y: 70, z: 5 } });

        // ~ is an offset from the bot, as in fill.
        await command.execute({
            ...ctx,
            args: ['~', '~', '~', '~2', '~', '~2'],
            bot: {
                position: { x: 4.5, y: 64, z: -1.5 },
                cspy: { scan: async options => { asked = options; return result(); } }
            }
        });
        assert.deepStrictEqual(asked.from, { x: 4, y: 64, z: -2 });
        assert.deepStrictEqual(asked.to, { x: 6, y: 64, z: 0 });

        // Half a box, a box too big to walk, or a corner that is not a number is
        // answered instead of swept.
        const refused = [];
        const refuse = async args => {
            refused.length = 0;
            await command.execute({ ...ctx, args, reply: parts => refused.push(parts) });
            return JSON.stringify(refused[0]);
        };
        assert.match(await refuse(['10', '64', '-5']), /x1 y1 z1 x2 y2 z2/, 'six numbers, two corners');
        assert.match(await refuse(['0', '0', '0', '40000', '0', '0']), /keep it to 32768 or fewer/);
        assert.match(await refuse(['0', '0', '0', '1', 'x', '1']), /whole numbers/);

        // A server that answers nothing is said plainly: the bot needs op.
        const quietReplies = [];
        await command.execute({
            ...ctx,
            reply: parts => quietReplies.push(parts),
            bot: {
                cspy: {
                    scan: async () => ({ ok: true, cells: 9, answered: 0, misses: 9, from: { x: 0, y: 64, z: 0 }, to: { x: 2, y: 64, z: 2 }, found: [] })
                }
            }
        });
        assert.match(JSON.stringify(quietReplies[0]), /opped/, 'unanswered queries are a permission problem');
    });

    await check('a deop loop makes the filter guard leave and change the address', async () => {
        const EventEmitter = require('node:events');
        const { FilterGuard } = require('../src/filterguard');

        const steps = [];
        const guardBot = new EventEmitter();
        guardBot.client = { entityId: 5 };
        guardBot.destroyed = false;
        guardBot.registry = null;
        guardBot.stop = reason => steps.push(`stop:${reason}`);
        guardBot.start = () => steps.push('start');
        guardBot.rollUsername = () => steps.push('rename');

        const warp = {
            enabled: true,
            rotate: async () => {
                steps.push('rotate');
                return true;
            }
        };
        const guard = new FilterGuard({ bot: guardBot, config: { settleMs: 0 }, warp, logger });
        guard.onReady();

        const deop = () => guard.onEntityStatus({ entityId: 5, entityStatus: 24 });

        // Another player being deopped is not this bot's business.
        for (let i = 0; i < 60; i++) guard.onEntityStatus({ entityId: 99, entityStatus: 24 });
        assert.strictEqual(guard.deops.length, 0, 'only the bot itself counts');
        assert.strictEqual(guard.rotations, 0);

        // 39 deops in a minute is not a filter yet.
        for (let i = 0; i < 39; i++) {
            guard.opLevel = 4;
            deop();
        }
        assert.strictEqual(guard.deops.length, 39);
        assert.strictEqual(guard.rotations, 0, 'below the limit nothing happens');

        // The fortieth is: leave, change the address, come back.
        guard.opLevel = 4;
        deop();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.strictEqual(guard.rotations, 1, 'one address change');
        assert.ok(steps.includes('rotate'), 'the address is changed');
        assert.ok(steps.some(step => step.startsWith('stop:')), 'the bot leaves the server first');
        assert.ok(steps.indexOf('rename') > steps.indexOf('rotate'), 'a new name goes with the new address');
        assert.ok(steps.indexOf('rename') < steps.indexOf('start'), 'and it is taken before the next join');
        assert.strictEqual(steps[steps.length - 1], 'start', 'and comes back on the new one');

        // Three changes are the most it gets; after that it stays in game.
        for (let round = 0; round < 5; round++) {
            for (let i = 0; i < 40; i++) {
                guard.opLevel = 4;
                deop();
            }
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        assert.strictEqual(guard.rotations, 3, 'no more than three address changes');
        assert.strictEqual(guard.staying, true, 'then it stays in game');

        // With WARP off there is no address to change: it stays straight away.
        const offBot = new EventEmitter();
        offBot.client = { entityId: 6 };
        offBot.stop = () => {};
        offBot.start = () => {};
        const offGuard = new FilterGuard({
            bot: offBot,
            config: { settleMs: 0 },
            warp: { enabled: false, rotate: async () => false },
            logger
        });
        offGuard.onReady();
        for (let i = 0; i < 40; i++) {
            offGuard.opLevel = 4;
            offGuard.onEntityStatus({ entityId: 6, entityStatus: 24 });
        }
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.strictEqual(offGuard.rotations, 0, 'no rotation without WARP');
        assert.strictEqual(offGuard.staying, true, 'it stays in game instead');
        guard.destroy();
        offGuard.destroy();
    });

    await check('a random username is rolled again when the address changes', () => {
        const { Bot } = require('../src/bot/bot');
        const roll = Bot.prototype.rollUsername;

        // `randomName: true` is an identity the server never learns for long.
        const random = { randomName: true, username: 'Abc123xy' };
        const renamed = roll.call({ server: random, log: logger });
        assert.match(renamed, /^[A-Za-z0-9]{8}$/, 'a fresh name, not the filtered one');
        assert.notStrictEqual(renamed, 'Abc123xy');
        assert.strictEqual(random.username, renamed, 'the bot joins with the new one');

        // A name from config is the bot's identity: op and permissions hang off
        // it, so it is left alone.
        const fixed = { randomName: false, username: 'SteveBot' };
        assert.strictEqual(roll.call({ server: fixed, log: logger }), null);
        assert.strictEqual(fixed.username, 'SteveBot');
    });

    await check('warp changes the address by re-registering and restarting its proxy', async () => {
        const { Warp } = require('../src/warp');

        const calls = [];
        let running = false;
        const warp = new Warp({
            config: { enabled: true, port: 25344 },
            logger,
            run: async (binary, args) => {
                calls.push([binary, ...args]);
                if (args[0] === 'start' || args[0] === 'restart') running = true;
                if (args[0] === 'stop') running = false;
                return { ok: true, stdout: running ? 'Proxy is running on 127.0.0.1:25344' : 'not running', stderr: '' };
            }
        });

        assert.strictEqual(await warp.rotate(), true);
        assert.deepStrictEqual(calls.map(call => call.slice(1)), [
            ['stop'],
            ['register', '--force'],
            ['restart', '--detach', '--no-update-check', '--port', '25344'],
            ['status']
        ], 'stop, a new account, then the proxy again on it');
        assert.ok(/warproxy$/.test(calls[0][0]), `the proxy client, not warp-cli: ${calls[0][0]}`);

        // A registration that fails means no new address, and the caller is told.
        const failing = new Warp({
            config: { enabled: true },
            logger,
            run: async (binary, args) => (args[0] === 'register'
                ? { ok: false, stdout: '', stderr: 'no network' }
                : { ok: true, stdout: 'Proxy is running', stderr: '' })
        });
        assert.strictEqual(await failing.rotate(), false);

        // Turned off, the client is never run at all.
        let touched = 0;
        const off = new Warp({
            config: {},
            logger,
            run: async () => {
                touched += 1;
                return { ok: true, stdout: '', stderr: '' };
            }
        });
        assert.strictEqual(await off.rotate(), false);
        assert.strictEqual(touched, 0, 'nothing runs when WARP is off');
    });

    await check('a socks5 tunnel carries the connection and the client uses it', async () => {
        const net = require('node:net');
        const EventEmitter = require('node:events');
        const { socksConnect } = require('../src/socks');
        const { Warp } = require('../src/warp');

        // Just enough SOCKS5: greet, take the CONNECT, then say hello down the
        // tunnel so the bytes have to come back through it.
        const seen = [];
        const proxy = net.createServer(socket => {
            socket.on('error', () => {});
            socket.once('data', greeting => {
                seen.push(['greeting', greeting[1]]);
                socket.write(Buffer.from([0x05, 0x00]));
                socket.once('data', request => {
                    const nameLength = request[4];
                    seen.push(['request', request.subarray(5, 5 + nameLength).toString(), request.readUInt16BE(5 + nameLength)]);
                    socket.write(Buffer.from([0x05, 0x00, 0x00, 0x03, 0x09, ...Buffer.from('127.0.0.1'), 0x1f, 0x90]));
                    setTimeout(() => socket.write(Buffer.from('hello from the tunnel')), 10);
                });
            });
        });
        await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
        const proxyPort = proxy.address().port;

        const socket = await socksConnect({
            proxyHost: '127.0.0.1',
            proxyPort,
            host: 'play.example.net',
            port: 25565,
            timeoutMs: 3000
        });
        socket.resume();
        const payload = await new Promise(resolve => socket.once('data', chunk => resolve(chunk.toString())));
        socket.destroy();

        assert.deepStrictEqual(seen[0], ['greeting', 0x01], 'no authentication offered');
        // The name goes to the proxy, so the lookup happens at the far end.
        assert.deepStrictEqual(seen[1], ['request', 'play.example.net', 25565], 'a socks5h connect');
        assert.strictEqual(payload, 'hello from the tunnel');

        // The client is handed that socket, and the connect event it waits for.
        // It starts ended, as minecraft-protocol's own client does until setSocket.
        const client = new EventEmitter();
        client.ended = true;
        client.setSocket = handed => { client.socket = handed; client.ended = false; };
        let connected = 0;
        client.on('connect', () => { connected += 1; });

        const warp = new Warp({
            config: { enabled: true, host: '127.0.0.1', port: proxyPort, timeoutMs: 3000 },
            logger,
            run: async (binary, args) => ({
                ok: true,
                stdout: args[0] === 'status' ? 'Proxy is running on 127.0.0.1:25344' : '',
                stderr: ''
            })
        });
        assert.strictEqual(await warp.attach(client, { host: 'play.example.net', port: 25565 }), true);
        // The event is replayed on the next tick: createClient only attaches the
        // protocol handlers after the connect callback returns, so emitting it
        // inside the callback lands on nobody and the handshake is never written.
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(connected, 1, 'the connect event the client waits for');
        assert.strictEqual(client.ended, false, 'a fresh client that is ended only until its socket is set still gets one');
        assert.ok(client.socket, 'a socket to the server');
        client.socket.destroy();

        // A client that really is gone takes no socket, and the one that was
        // opened for it is closed instead of left hanging on the tunnel.
        const unused = { destroyed: false, destroy() { this.destroyed = true; } };
        const gone = new EventEmitter();
        gone.ended = true;
        gone.socket = { destroyed: true };
        gone.setSocket = () => { throw new Error('a socket was handed to a client that was already gone'); };
        const guarding = new Warp({
            config: { enabled: true, host: '127.0.0.1', port: proxyPort, timeoutMs: 3000 },
            logger,
            run: async (binary, args) => ({
                ok: true,
                stdout: args[0] === 'status' ? 'Proxy is running on 127.0.0.1:25344' : '',
                stderr: ''
            }),
            connect: async () => unused
        });
        assert.strictEqual(await guarding.attach(gone, { host: 'play.example.net', port: 25565 }), false);
        assert.strictEqual(unused.destroyed, true, 'the socket opened for a gone client is closed');
        assert.strictEqual(gone.socket.destroyed, true, 'nothing else happened to it');

        // One that was ended while the tunnel was opening has no socket either.
        const aborted = new EventEmitter();
        aborted.ended = true;
        aborted.serializer = { writableEnded: true };
        aborted.setSocket = () => { throw new Error('a socket was handed to an ended client'); };
        assert.strictEqual(await guarding.attach(aborted, { host: 'play.example.net', port: 25565 }), false);

        proxy.close();
    });

    await check('a bot teleported into the end is brought back to the overworld', async () => {
        const EventEmitter = require('node:events');
        const { SelfCare } = require('../src/selfcare');

        const sent = [];
        const lostBot = new EventEmitter();
        lostBot.server = { username: 'vbot' };
        lostBot.client = { uuid: '00000000-0000-0000-0000-000000000003', entityId: 9, chat: () => {} };
        lostBot.sendChat = command => (sent.push(command), true);
        lostBot.core = null;

        const care = new SelfCare({
            bot: lostBot,
            config: { creative: false, commandSpy: false, vanish: false, unmute: false },
            logger
        });
        care.onReady();
        // It stood here before the teleport; the end's coordinates are not this.
        care.notePosition({ x: 10.4, y: 64, z: -20.6 });
        care.noteDimension('minecraft:the_end');
        care.notePosition({ x: 0, y: 100, z: 0 });

        await new Promise(resolve => setTimeout(resolve, 1750));
        assert.ok(
            sent.includes('/execute in minecraft:overworld run tp vbot 10 64 -21'),
            `come back to where it last stood: ${JSON.stringify(sent)}`
        );

        // Once it is back, nothing more is asked for.
        sent.length = 0;
        care.noteDimension('minecraft:overworld');
        await new Promise(resolve => setTimeout(resolve, 1800));
        assert.strictEqual(sent.length, 0, 'nothing is sent from the overworld');
        care.destroy();
    });

    await check('item numbers come from the server registries', async () => {
        // A registry packet is a list; the position in it is the id.
        const registryBot = new Bot({
            server: { id: 'reg', host: '127.0.0.1', port: 1, username: 'vbot', auth: 'offline' },
            config,
            store,
            permissions,
            registry: { dispatch: async () => {} },
            logger
        });
        assert.strictEqual(registryBot.noteRegistry({
            id: 'minecraft:item',
            entries: [{ key: 'minecraft:air' }, { key: 'minecraft:stone' }, { key: 'minecraft:command_block' }]
        }), true);
        assert.strictEqual(registryBot.registries.item.get('command_block'), 2);
        assert.strictEqual(registryBot.noteRegistry({
            id: 'minecraft:data_component_type',
            entries: [{ key: 'minecraft:custom_data' }, { key: 'minecraft:block_entity_data' }]
        }), true);
        assert.strictEqual(registryBot.registries.components.get('block_entity_data'), 1);
        assert.strictEqual(registryBot.noteRegistry({ id: 'minecraft:item', entries: [] }), false);
        registryBot.destroy();
    });

    await check('refills go through the bot\'s own command blocks, commands go into the area', async () => {
        const used = [];
        const sent = [];
        const writes = [];
        const core = new Core({
            bot: {
                position: { x: 0, y: 70, z: 0 },
                chat: command => sent.push(command),
                write: (name, payload) => (writes.push({ name, payload }), true),
                log: logger
            },
            config: { enabled: true, area: { size: 9, y: 64 }, refill: { enabled: true } },
            logger
        });
        core.reset();
        core.fillItem = {
            usable: true,
            run: (...commands) => (used.push(...commands.flat()), { x: 0, y: 63, z: 0 }),
            destroy: () => {}
        };

        // The very first build goes through the bot's blocks too: chat is never
        // the way a fill leaves the bot.
        assert.strictEqual(core.refill('damaged', { force: true }), true);
        assert.strictEqual(used.length, 1);
        assert.match(used[0], /^fill 0 64 0 8 72 8 /, 'the mini core carries the fill');
        assert.deepStrictEqual(sent, [], 'nothing goes out as chat');

        core.refill('damaged', { force: true });
        assert.strictEqual(used.length, 2);

        // A command is not run in the mini core: it is one write into a block of
        // the area that is already standing.
        const cell = core.run('say hi');
        assert.deepStrictEqual(cell, { x: 0, y: 64, z: 0 });
        assert.strictEqual(used.length, 2, 'the mini core is not handed the command');
        assert.strictEqual(writes.length, 1);
        assert.deepStrictEqual(writes[0], {
            name: 'update_command_block',
            payload: { location: { x: 0, y: 64, z: 0 }, command: 'say hi', mode: 1, flags: 0b101 }
        });
        assert.strictEqual(core.lastLocation, cell);
        core.destroy();
    });

    await check('the core rebuilds itself on an interval when nothing is left', async () => {
        const sent = [];
        const core = new Core({
            bot: {
                position: { x: 0, y: 70, z: 0 },
                chat: command => sent.push(command),
                write: () => true,
                log: logger
            },
            config: { enabled: true, area: { size: 2, y: 64 }, refill: { enabled: true, intervalMs: 25 } },
            logger
        });

        const fills = [];
        core.fillItem = {
            usable: true,
            run: (...commands) => (fills.push(...commands.flat()), { x: 0, y: 63, z: 0 }),
            destroy: () => {}
        };

        // A join rebuilds the core at once, through the bot's own blocks.
        core.onReady();
        assert.match(fills[0], /^fill 0 64 0 1 65 1 /);
        await new Promise(resolve => setTimeout(resolve, 450));
        assert.strictEqual(core.ready, true);

        // Nothing standing: the watchdog rebuilds it the same way, repeatedly.
        for (const key of core.blocks.keys()) core.blocks.set(key, false);
        fills.length = 0;
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.ok(fills.length >= 1, 'the watchdog should rebuild the core through its own blocks');
        assert.match(fills[0], /^fill 0 64 0 1 65 1 /);
        assert.deepStrictEqual(sent, [], 'nothing goes out as chat');

        core.destroy();
        const after = fills.length;
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.strictEqual(fills.length, after, 'destroy stops the watchdog');
    });

    await check('a join teleports before the core is filled', async () => {
        const handed = [];
        const writes = [];
        const joinBot = {
            position: { x: 0, y: 64, z: 0 },
            server: { username: 'vbot' },
            chat: () => true,
            write: (name, payload) => (writes.push({ name, payload }), true),
            log: logger
        };
        const core = new Core({
            bot: joinBot,
            config: { enabled: true, area: { size: 2, y: 64 }, refill: { enabled: true, intervalMs: 60_000 } },
            logger
        });
        core.fillItem = {
            usable: true,
            run: (...commands) => (handed.push(...commands.flat()), { x: 0, y: 63, z: 0 }),
            // The block of the cube that ends up running the teleport.
            cells: () => [{ x: 1, y: 63, z: 0 }],
            destroy: () => {}
        };

        core.onReady();

        // The teleport is the first command out and nothing is filled at spawn:
        // the bot is about to leave, and a core built here would be left behind.
        const tp = writes.find(write => write.payload?.command?.startsWith('tp vbot '));
        assert.ok(tp, 'the join teleports first');
        const target = /^tp vbot (-?\d+) (-?\d+) (-?\d+)$/.exec(tp.payload.command);
        assert.ok(target, tp.payload.command);
        assert.strictEqual(target[2], '100', 'the rtp height');
        assert.deepStrictEqual(handed.filter(text => text.startsWith('fill ')), [],
            'nothing is filled at spawn before the teleport');
        assert.strictEqual(core.joining, true);

        // The server answers the teleport: the core is filled where the bot
        // landed, and the blocks the join wrote at the old spot are cleared.
        joinBot.position = { x: Number(target[1]), y: 100, z: Number(target[3]) };
        await new Promise(resolve => setTimeout(resolve, 600));

        assert.strictEqual(core.joining, false);
        const fills = handed.filter(text => text.startsWith('fill '));
        assert.strictEqual(fills.length, 1, 'one fill, at the new spot');
        const x = Math.floor(Number(target[1]) / 2) * 2;
        const z = Math.floor(Number(target[3]) / 2) * 2;
        assert.strictEqual(fills[0],
            `fill ${x} 64 ${z} ${x + 1} 65 ${z + 1} minecraft:repeating_command_block replace`);
        assert.deepStrictEqual(core.origin, { x, y: 64, z });

        const commands = writes.map(write => write.payload?.command || '');
        const clearMini = commands.indexOf('setblock 1 63 0 minecraft:air');
        const clearCell = commands.indexOf('setblock 0 64 0 minecraft:air');
        assert.ok(clearMini >= 0, 'the mini core block at the old spot is cleared');
        assert.ok(clearCell >= 0, 'the core block that ran the teleport is cleared');
        assert.ok(clearMini < clearCell, 'the mini core is cleared before the cell it creates');

        core.destroy();
    });

    await check('a join fills at once when the teleport is turned off', () => {
        const handed = [];
        const bot = {
            position: { x: 0, y: 64, z: 0 },
            server: { username: 'vbot' },
            chat: () => true,
            write: () => true,
            log: logger
        };
        const core = new Core({
            bot,
            config: {
                enabled: true,
                area: { size: 2, y: 64 },
                joinRtp: false,
                refill: { enabled: true, intervalMs: 60_000 }
            },
            logger
        });
        core.fillItem = {
            usable: true,
            run: (...commands) => (handed.push(...commands.flat()), { x: 0, y: 63, z: 0 }),
            destroy: () => {}
        };

        core.onReady();

        assert.match(handed[0], /^fill 0 64 0 1 65 1 /, 'the core is filled straight away');
        assert.strictEqual(core.joining, false);
        assert.ok(!handed.some(text => text.includes('Command:"tp ')), 'nothing teleports');
        core.destroy();
    });

    await check('selfcare unmutes and keeps command spy on', async () => {
        const EventEmitter = require('node:events');
        const { SelfCare } = require('../src/selfcare');

        const sent = [];
        const bot = new EventEmitter();
        bot.server = { username: 'vbot' };
        bot.client = { uuid: '00000000-0000-0000-0000-000000000001', entityId: 7, chat: () => {} };
        bot.chat = command => (sent.push(command), true);
        bot.core = { ready: true, run: command => (sent.push(command), { x: 0, y: 64, z: 0 }) };

        const care = new SelfCare({ bot, config: {}, logger });
        care.onReady();

        // A mute is undone as soon as the server says it happened.
        care.onMessage({ line: 'You have been muted for 5 minutes' });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.ok(
            sent.some(command => command.startsWith('mute 00000000-0000-0000-0000-000000000001')),
            'a mute should be lifted'
        );

        // Command spy is confirmed by its own message and then left alone.
        sent.length = 0;
        care.onMessage({ line: 'Successfully enabled commandspy' });
        assert.strictEqual(care.spyOn, true);
        care.tick();
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(!sent.some(command => command.startsWith('c ')), 'spy is not re-enabled when it is on');

        care.destroy();
    });

    await check('runTracked reads the block output back through an nbt query', async () => {
        const EventEmitter = require('node:events');
        const client = new EventEmitter();
        const writes = [];
        const coreBot = {
            client: { version: '1.21.4' },
            position: { x: 0, y: 70, z: 0 },
            chat: () => {},
            log: logger,
            write: (name, payload) => (writes.push({ name, payload }), true)
        };
        const core = new Core({
            bot: coreBot,
            config: { enabled: true, area: { size: 2, y: 64 }, refill: { enabled: true } },
            logger
        });
        core.reset();
        core.bindClient(client);

        const pending = core.runTracked('list', { delay: 5, timeout: 500 });
        await new Promise(resolve => setTimeout(resolve, 20));

        const query = writes.find(write => write.name === 'query_block_nbt');
        assert.ok(query, 'the tracked run asks for the block NBT');
        assert.deepStrictEqual(query.payload.location, core.lastLocation);

        // Typed NBT, the way 1.20.2+ delivers it.
        client.emit('nbt_query_response', {
            transactionId: query.payload.transactionId,
            nbt: {
                type: 'compound',
                value: {
                    Command: { type: 'string', value: 'list' },
                    LastOutput: {
                        type: 'compound',
                        value: { text: { type: 'string', value: 'There are 2 players online' } }
                    }
                }
            }
        });

        assert.strictEqual(await pending, 'There are 2 players online');

        // No answer at all resolves to null instead of hanging.
        const unanswered = core.runTracked('list', { delay: 5, timeout: 40 });
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.strictEqual(await unanswered, null);

        core.destroy();
    });

    await check('core reads the fill result the server reports', () => {
        const core = new Core({
            bot: { position: { x: 0, y: 70, z: 0 }, chat: () => {}, write: () => true, log: logger },
            config: { enabled: true, area: { size: 2, y: 64 }, refill: { enabled: true } },
            logger
        });
        core.reset();

        // Servers send this as a translate key, so the raw text carries the count.
        assert.strictEqual(core.noteMessage('commands.fill.success8'), true);
        assert.strictEqual(core.lastFill.blocks, 8);
        assert.strictEqual(core.lastFill.ok, true);

        // The count is blocks changed: a core already in place changes few.
        assert.strictEqual(core.noteMessage('commands.fill.success1'), true);
        assert.strictEqual(core.lastFill.blocks, 1);
        assert.strictEqual(core.lastFill.ok, true, 'a small count is not a failure');

        // Nothing standing and nothing filled is a real failure.
        assert.strictEqual(core.noteMessage('commands.fill.failed'), true);
        assert.strictEqual(core.lastFill.ok, false);
        assert.strictEqual(core.fillFailures, 1);

        // Same message with blocks standing means the core was already full.
        core.markAllAlive();
        assert.strictEqual(core.noteMessage('commands.fill.failed'), true);
        assert.strictEqual(core.lastFill.ok, true, 'an unchanged core is already in place');
        assert.strictEqual(core.ready, true);
        assert.strictEqual(core.fillFailures, 0);

        assert.strictEqual(core.noteMessage('<Steve> hello'), false);
        core.destroy();
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
        const fills = [];
        core.fillItem = {
            usable: true,
            run: (...commands) => (fills.push(...commands.flat()), { x: 0, y: 63, z: 0 }),
            destroy: () => {}
        };
        core.reset();
        core.refill('startup');
        await new Promise(resolve => setTimeout(resolve, 300));
        fills.length = 0;
        core.refilling = false;
        core.graceUntil = 0;
        core.lastRefillAt = 0;
        core.ready = true;
        core.markAllAlive();

        core.onBlockChange({ location: { x: 1, y: 64, z: 1 } });
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.ok(fills.length >= 1, 'damage should trigger a refill');
        assert.match(fills[fills.length - 1], /^fill 0 64 0 3 67 3 /);
        assert.deepStrictEqual(sent, [], 'a refill never goes out as chat');
        core.destroy();
    });

    await check('an automatic refill reuses a surviving block, and nothing ever chats', async () => {
        const sent = [];
        const writes = [];
        const coreBot = {
            position: { x: 0, y: 70, z: 0 },
            chat: command => sent.push(command),
            write: (name, payload) => (writes.push({ name, payload }), true),
            log: logger
        };
        const core = new Core({
            bot: coreBot,
            // The mini core has its own checks: with it off, everything goes
            // through what is left of the main core.
            config: { enabled: true, area: { size: 2, y: 64 }, refill: { enabled: true, item: false } },
            logger
        });
        core.reset();
        core.markAllAlive();
        core.everReady = true;

        // One survivor left: the refill writes into it, quietly.
        for (const key of core.blocks.keys()) {
            if (key !== '1:65:1') core.blocks.set(key, false);
        }
        core.lastRefillAt = 0; // pretend the last refill is old enough
        core.refill('damaged');
        assert.deepStrictEqual(sent, [], 'a surviving block carries the fill');
        assert.strictEqual(writes.length, 1);
        assert.deepStrictEqual(writes[0].payload.location, { x: 1, y: 65, z: 1 });
        assert.match(writes[0].payload.command, /^fill 0 64 0 1 65 1 /);
        assert.strictEqual(writes[0].payload.mode, 1, 'the core blocks are repeating ones');

        // An explicit refill takes the same route: there is no chat path at all.
        await new Promise(resolve => setTimeout(resolve, 450));
        sent.length = 0;
        writes.length = 0;
        core.lastRefillAt = 0;
        core.refilling = false;
        core.refill('command', { force: true });
        assert.deepStrictEqual(sent, [], 'nothing is ever sent as chat');
        assert.strictEqual(writes.length, 1);
        assert.strictEqual(writes[0].name, 'update_command_block');
        assert.match(writes[0].payload.command, /^fill 0 64 0 1 65 1 /);
        core.destroy();
    });

    // --- commands -----------------------------------------------------------
    await check('database stores only identity and ranks', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-schema-'));
        const scratch = new Store(path.join(dir, 'vbot.sqlite')).open();
        const columns = table =>
            scratch.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);

        assert.deepStrictEqual(
            columns('players'),
            ['name_key', 'name', 'uuid', 'first_seen', 'last_seen', 'version', 'version_at']
        );
        assert.deepStrictEqual(columns('users'), ['name_key', 'name', 'uuid', 'level', 'granted_by', 'granted_at']);

        // Addresses are stored because /alts cannot work without them.
        assert.deepStrictEqual(
            columns('player_ips'),
            ['name_key', 'ip', 'uuid', 'first_seen', 'last_seen']
        );

        const tables = scratch.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map(row => row.name)
            .filter(name => !name.startsWith('sqlite_'));
        assert.deepStrictEqual(tables.sort(), ['player_ips', 'players', 'users'], `unexpected tables: ${tables}`);
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
        assert.ok(columns.includes('version'), 'the last known version column should be added');
        assert.ok(columns.includes('version_at'));
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

    await check('a last known version is kept on the player row', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-version-'));
        const scratch = new Store(path.join(dir, 'vbot.sqlite')).open();

        const first = scratch.recordVersion('Steve', '26.3');
        assert.strictEqual(first.version, '26.3');
        assert.ok(first.version_at > 0, 'it carries when it was seen');

        scratch.recordVersion('Steve', '1.21.4');
        assert.strictEqual(scratch.getPlayer('Steve').version, '1.21.4', 'the newest replaces the last');
        scratch.close();
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

    const ENTITY_SELECTOR = '{"selector":"@e[limit=100]"}';

    const sent = [];
    const fakeBot = {
        // Pre-1.21.5, so replies use the JSON component shape the tests parse.
        client: { latency: 12, version: '1.21.4' },
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

    const runWith = async (line, flags = {}, botExtra = {}) => {
        sent.length = 0;
        await registry.dispatch({ bot: { ...fakeBot, ...botExtra }, parsed: parseChatLine(line), ...flags });
        return decodeReply(sent[0]);
    };

    // `tab` is trusted, so a token prompt means the rank was not used.
    await check('a rank is only used for a real chat packet', async () => {
        const real = await runWith('<Steve> v:tab', { verified: true, real: true });
        assert.ok(!/token/i.test(real), `real chat should keep the rank, got: ${real}`);

        // Custom chat is tellraw output: anyone can print a line that looks like
        // Steve, so it runs, but as public.
        const custom = await runWith('<Steve> v:tab', { verified: false, real: false });
        assert.match(custom, /needs a trusted token/);
        assert.match(custom, /not a chat message/);

        // A vanished player is online by selector only, so nothing they send can
        // be taken as a listed account's chat either.
        const vanishedBot = { online: new Map([['steve', { name: 'Steve', uuid, vanished: true }]]) };
        const vanished = await runWith('<Steve> v:tab', { verified: true, real: true }, vanishedBot);
        assert.match(vanished, /needs a trusted token/);
        assert.match(vanished, /vanished/);
    });

    await check('custom chat and vanished players still run public commands', async () => {
        const vanishedBot = { online: new Map([['steve', { name: 'Steve', uuid, vanished: true }]]) };
        const custom = await runWith('<Steve> v:ping', { verified: false, real: false }, vanishedBot);
        assert.ok(custom && !/token/i.test(custom), `public command should run, got: ${custom}`);
    });

    await check('servercrash switches methods and keeps the command valid', async () => {
        const commands = [];
        const crashBot = {
            // The real bot routes every leading slash into the core, replies
            // included, so the fake one tells the crash's own command apart from
            // the tellraw answer and records both sides.
            chat: text => {
                const value = String(text);
                if (!value.startsWith('/')) return false;
                if (value.startsWith('/tellraw ')) {
                    sent.push(value);
                    return true;
                }
                commands.push(value.slice(1));
                return true;
            }
        };

        const list = await runWith('<Steve> v:servercrash list', {}, crashBot);
        assert.match(list, /title/);

        const unknown = await runWith('<Steve> v:servercrash nope', {}, crashBot);
        assert.match(unknown, /Unknown method/);
        assert.strictEqual(commands.length, 0, 'an unknown method sends nothing');

        const plain = await runWith('<Steve> v:servercrash title', {}, crashBot);
        assert.match(plain, /Boom: title x900/);
        assert.strictEqual(commands.length, 1);
        assert.ok(commands[0].startsWith('title @a title '), `got: ${commands[0].slice(0, 40)}`);
        assert.strictEqual(commands[0].split(ENTITY_SELECTOR).length - 1, 900, 'one selector per count');

        const huge = await runWith('<Steve> v:servercrash title 5000', {}, crashBot);
        assert.match(huge, /clamped from 5000/);
        assert.ok(commands[1].length <= 32000, 'a cut command would be invalid JSON');
        assert.ok(commands[1].trimEnd().endsWith(']}'), 'the component stays closed');

        const tooMany = await runWith('<Steve> v:servercrash title abc', {}, crashBot);
        assert.match(tooMany, /x900/, 'a count that is not a number falls back to the default');
    });

    await check('crashchest seeds the chest and servercrash scoreboard reads it', async () => {
        const commands = [];
        const crashBot = {
            chat: text => {
                const value = String(text);
                if (!value.startsWith('/')) return false;
                if (value.startsWith('/tellraw ')) {
                    sent.push(value);
                    return true;
                }
                commands.push(value.slice(1));
                return true;
            },
            core: { ready: true, size: 9, origin: { x: 16, y: 64, z: -32 } },
            position: { x: 16, y: 64, z: -32 }
        };

        // Dispatched on the bot object itself, not a spread of it: the command
        // remembers the chest on `bot`, and a copy would swallow that.
        const crash = async line => {
            sent.length = 0;
            await registry.dispatch({ bot: crashBot, parsed: parseChatLine(line) });
            return decodeReply(sent[0]);
        };

        const built = await crash('<Steve> v:crashchest 2');
        assert.match(built, /Crash chest at 16 73 -32/);
        assert.strictEqual(commands[0], 'setblock 16 73 -32 minecraft:air');
        assert.strictEqual(commands[1], 'setblock 16 73 -32 minecraft:chest');

        const merge = commands[2];
        assert.ok(merge.startsWith('data merge block 16 73 -32 {CustomName:{text:"",extra:["'), `got: ${merge.slice(0, 60)}`);
        assert.ok(merge.length <= 32000, 'the seed still fits one core command');
        assert.ok(/[\u4e00-\u9fff]/.test(merge), 'the filler is an ideograph, three bytes a char');
        assert.strictEqual(
            commands.filter(command => command.startsWith('data modify block 16 73 -32 CustomName.extra append')).length,
            2,
            'one doubling per tick'
        );
        assert.deepStrictEqual(crashBot.crashChest, { x: 16, y: 73, z: -32 }, 'the chest is remembered');

        commands.length = 0;
        const fired = await crash('<Steve> v:servercrash scoreboard');
        assert.match(fired, /Scoreboard crash on 16 73 -32/);
        assert.ok(commands.includes('scoreboard objectives remove kickobj'));
        assert.ok(commands.includes('scoreboard objectives add kickobj dummy'));
        assert.ok(commands.includes('scoreboard objectives setdisplay sidebar kickobj'));
        const display = commands[commands.length - 1];
        assert.ok(display.startsWith('scoreboard players display name foo kickobj '), `got: ${display.slice(0, 60)}`);
        assert.ok(display.includes('"block":"16 73 -32"'), 'the display reads the chest');
        assert.ok(display.length <= 256, 'the trigger stays inside the command limit');

        commands.length = 0;
        const explicit = await crash('<Steve> v:servercrash scoreboard 1 2 3');
        assert.match(explicit, /Scoreboard crash on 1 2 3/);
        assert.ok(commands[commands.length - 1].includes('"block":"1 2 3"'), 'explicit coordinates win');

        commands.length = 0;
        const placed = await crash('<Steve> v:crashchest -120 70 400 1');
        assert.match(placed, /Crash chest at -120 70 400/);
        assert.strictEqual(commands[0], 'setblock -120 70 400 minecraft:air');
        assert.strictEqual(commands[1], 'setblock -120 70 400 minecraft:chest');
        assert.ok(commands[2].startsWith('data merge block -120 70 400 '), 'the chosen spot gets the seed');
        assert.strictEqual(
            commands.filter(command => command.startsWith('data modify block -120 70 400')).length,
            1,
            'the doubling count still applies'
        );
        assert.deepStrictEqual(crashBot.crashChest, { x: -120, y: 70, z: 400 }, 'the chosen chest is remembered');

        commands.length = 0;
        const reminder = await crash('<Steve> v:servercrash scoreboard');
        assert.match(reminder, /Scoreboard crash on -120 70 400/, 'the scoreboard follows the chosen chest');

        commands.length = 0;
        const rejected = await crash('<Steve> v:crashchest 1 2 3');
        assert.match(rejected, /Crash chest at 1 2 3/);
        commands.length = 0;
        assert.match(await crash('<Steve> v:crashchest 1 nope 3'), /Usage: v:crashchest \[x y z\] \[doublings\]/);
        assert.strictEqual(commands.length, 0, 'nothing is sent for bad coordinates');
    });

    await check('servercrash destroy builds the chest and breaks it with destroy mode', async () => {
        const { METHODS } = require(path.join(ROOT, 'src', 'commands', 'servercrash.js'));
        const sent = [];
        const replies = [];
        const ctx = {
            bot: {
                core: { ready: true, size: 9, origin: { x: 16, y: 64, z: -32 } },
                position: { x: 16, y: 64, z: -32 }
            },
            args: ['destroy', '-32', '-9', '64', '1'],
            prefix: 'v:',
            reply: text => (replies.push(String(text)), true),
            run: text => (sent.push(String(text)), true)
        };

        await METHODS.destroy.run(ctx);

        assert.strictEqual(sent[0], 'setblock -32 -9 64 minecraft:air');
        assert.strictEqual(sent[1], 'setblock -32 -9 64 minecraft:chest');
        assert.ok(sent[2].startsWith('data merge block -32 -9 64 {CustomName:'), 'the chosen spot gets the seed');
        assert.strictEqual(
            sent.filter(command => command.startsWith('data modify block -32 -9 64 CustomName.extra append')).length,
            1,
            'the doubling argument still applies'
        );
        assert.strictEqual(sent[sent.length - 1], 'setblock -32 -9 64 minecraft:air destroy',
            'the chest is broken with destroy, not replaced');
        assert.ok(!sent.some(command => command.startsWith('tellraw')), 'the break goes out as a command');
        assert.match(replies[0], /Crash chest at -32 -9 64/);
        assert.match(replies[replies.length - 1], /Breaking it/);
        assert.deepStrictEqual(ctx.bot.crashChest, { x: -32, y: -9, z: 64 }, 'the chest is remembered');
    });

    await check('servercrash names its methods on hover', () => {
        const entry = registry.find('servercrash');
        assert.ok(entry, 'servercrash is loaded');
        const hover = typeof entry.hover === 'function' ? entry.hover() : entry.hover;
        assert.ok(hover, 'the entry carries a hover');
        assert.match(hover, /title: /);
        assert.match(hover, /scoreboard: /);
        assert.match(hover, /destroy: crash chest, then setblock it to air with destroy/);
    });

    await check('a session rank is cleared when the player joins again', () => {
        permissions.grant('Bob', LEVEL.TRUSTED, 'token');
        assert.strictEqual(permissions.levelFor({ name: 'Bob' }), LEVEL.TRUSTED);
        assert.strictEqual(permissions.clearSessionRank('Bob'), true);
        assert.strictEqual(permissions.levelFor({ name: 'Bob' }), LEVEL.PUBLIC);

        // A rank from Discord or from the config is not a session unlock, so a
        // rejoin leaves it alone.
        permissions.grant('Carol', LEVEL.TRUSTED, 'discord:1234');
        assert.strictEqual(permissions.clearSessionRank('Carol'), false);
        assert.strictEqual(permissions.levelFor({ name: 'Carol' }), LEVEL.TRUSTED);
        assert.strictEqual(permissions.clearSessionRank('Steve'), false, 'selfcheck grants are not tokens');
        assert.strictEqual(permissions.levelFor({ name: 'Steve' }), LEVEL.ADMIN);
    });

    await check('commands load with unique names and aliases', () => {
        assert.ok(registry.commands.size >= 5, `expected commands, got ${registry.commands.size}`);
        assert.ok(registry.find('whois'), 'identity alias missing');
        assert.strictEqual(registry.find('whoami').name, 'whoami');
    });

    await check('the degree prefix is a real prefix', () => {
        const exampleConfig = loadConfig(examplePath);
        // Prefix matching is what is being tested, so the in-game switch is on
        // here whatever the shipped config prefers.
        exampleConfig.bot.inGamePrefixes = true;
        assert.ok(exampleConfig.bot.prefixes.includes('\u00b0'), 'the example config ships it');

        const degreeRegistry = new CommandRegistry({
            dir: path.join(ROOT, 'src', 'commands'),
            config: exampleConfig,
            permissions,
            store,
            logger,
            tokens
        }).loadAll();

        assert.strictEqual(degreeRegistry.matchPrefix('\u00b0help'), '\u00b0');
        assert.strictEqual(degreeRegistry.matchPrefix('\\help'), '\\');
        assert.strictEqual(degreeRegistry.matchPrefix('!help'), null);
    });

    await check('in-game prefixes can be switched off in config', async () => {
        const quiet = new CommandRegistry({
            dir: path.join(ROOT, 'src', 'commands'),
            config: { ...config, bot: { ...config.bot, inGamePrefixes: false } },
            permissions,
            store,
            logger,
            tokens
        }).loadAll();

        assert.strictEqual(quiet.matchPrefix('v:help'), null, 'no chat line matches a prefix');
        sent.length = 0;
        assert.strictEqual(
            await quiet.dispatch({ bot: fakeBot, parsed: parseChatLine('<Steve> v:help') }),
            false,
            'nothing in game runs a command'
        );
        assert.strictEqual(sent.length, 0);

        // The same commands still answer a raw dispatch: that is what /sudo uses.
        const handled = await quiet.dispatch({
            bot: fakeBot,
            parsed: { username: 'Steve', message: 'help' },
            raw: true
        });
        assert.strictEqual(handled, true);
        assert.match(decodeReply(sent[0]), /^Commands \(\d+\)/);
    });

    await check('a raw dispatch runs as a player and answers both ways', async () => {
        sent.length = 0;
        const lines = [];
        const handled = await registry.dispatch({
            bot: fakeBot,
            parsed: { username: 'VojtaV12', message: 'whoami' },
            raw: true,
            sink: value => lines.push(value)
        });

        assert.strictEqual(handled, true);
        assert.ok(sent.some(line => line.startsWith('/tellraw VojtaV12 ')), 'the player is answered in game');
        assert.strictEqual(lines.length, 1, 'and the same reply reaches the sink');
        assert.match(lines[0], /VojtaV12/);
    });

    await check('help lists a player only the commands their rank has', async () => {
        sent.length = 0;
        await registry.dispatch({ bot: fakeBot, parsed: parseChatLine('<Unranked> v:help') });
        const output = decodeReply(sent[0]);
        assert.match(output, /^Commands \(\d+\)/);
        assert.match(output, /public: .*help/);
        assert.match(output, /public: alts /);
        assert.match(output, /public: .*core/, 'the core command is public');
        assert.doesNotMatch(output, /trusted:/, 'no rank above theirs is listed');
        assert.doesNotMatch(output, /admin:/);
        assert.doesNotMatch(output, /identity|servercrash|crashchest/);

        // Everything listed is clickable, so nothing they cannot use is shown.
        const listing = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);
        const names = listing.filter(part => part.clickEvent).map(part => part.text);
        assert.ok(names.length >= 5);
        for (const name of names) {
            assert.ok(registry.find(name).level <= LEVEL.PUBLIC, `${name} must be within their rank`);
        }

        // Asking about one above them says what it needs, not what it does.
        sent.length = 0;
        await registry.dispatch({ bot: fakeBot, parsed: parseChatLine('<Unranked> v:help filter') });
        assert.match(decodeReply(sent[0]), /filter needs admin; you are public\./);
    });

    await check('an owner sees every rank of command as usable', async () => {
        config.permissions.owner = ['VojtaV12'];
        sent.length = 0;
        await registry.dispatch({ bot: fakeBot, parsed: parseChatLine('<VojtaV12> v:help') });
        const listing = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);
        for (const name of ['help', 'identity', 'core']) {
            const part = listing.find(entry => entry.text === name);
            assert.ok(part, `${name} should be listed`);
            assert.ok(part.clickEvent, `${name} should be clickable for an owner`);
        }
        assert.ok(listing.filter(part => part.clickEvent).length >= 7);
    });

    await check('help is coloured and clickable', async () => {
        sent.length = 0;
        await registry.dispatch({ bot: fakeBot, parsed: parseChatLine('<Unranked> v:help') });
        const listing = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);
        assert.ok(Array.isArray(listing), 'help should be a component array');
        assert.ok(listing.some(part => part.color), 'help should be coloured');

        const clicks = listing.filter(part => part.clickEvent?.action === 'suggest_command');
        assert.ok(clicks.length >= 5, 'each listed command should be clickable');
        for (const part of clicks) {
            // Clicking a command opens its help; it never fires the command.
            assert.strictEqual(part.clickEvent.value, `v:help ${part.text}`);
            assert.ok(registry.find(part.text), `${part.text} should be a real command`);
        }

        // A single command explains itself, with its name suggested on click.
        sent.length = 0;
        await registry.dispatch({ bot: fakeBot, parsed: parseChatLine('<Unranked> v:help ping') });
        const detail = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);
        assert.strictEqual(detail[0].clickEvent.action, 'suggest_command');
        assert.strictEqual(detail[0].clickEvent.value, 'v:ping');
        assert.match(decodeReply(sent[0]), /ping — .*latency.* \[public\]/);
    });

    await check('1.21.5+ servers get the SNBT component shape', async () => {
        const modernBot = { ...fakeBot, client: { latency: 12, version: '1.21.5' } };
        sent.length = 0;
        await registry.dispatch({ bot: modernBot, parsed: parseChatLine('<Unranked> v:help') });

        // Clicking only works with the new field names, which is the whole point.
        assert.match(sent[0], /^\/tellraw Unranked \[?\{text:'Commands'/);
        assert.match(sent[0], /click_event:\{action:'suggest_command',command:'v:help /);
        assert.match(sent[0], /hover_event:\{action:'show_text',value:\{text:'/);
        assert.ok(!sent[0].includes('clickEvent'), 'the old field name is ignored by 1.21.5+');
        assert.ok(!sent[0].includes('hoverEvent'));

        // Newer numbering still counts as modern.
        const { isModern } = require('../src/minecraft/tellraw');
        for (const version of ['1.21.5', '1.21.6', '1.22', '26.1.2']) {
            assert.strictEqual(isModern(version), true, `${version} should use the modern shape`);
        }
        for (const version of ['1.21.4', '1.21', '1.20.4', '1.8.9']) {
            assert.strictEqual(isModern(version), false, `${version} should use the JSON shape`);
        }
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
        assert.match(decodeReply(sent[0]), /Alex — 069a79f4/);

        // trustUnsigned: false keeps unsigned chat out even without signing.
        const strict = loadConfig(examplePath);
        strict.bot.prefixes = ['v:'];
        strict.bot.inGamePrefixes = true;
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

    await check('identity shows the whois fields in colour', async () => {
        const lookup = {
            usable: true,
            details: async () => ({
                ips: ['246.37.222.31'],
                source: 'whois {player}',
                fields: {
                    nick: 'VojtaV12',
                    uuid: '2f1d16b9-7337-31d7-997f-acaa527152d9',
                    gamemode: 'creative',
                    health: '20/20',
                    ip: '246.37.222.31',
                    op: 'true'
                }
            })
        };

        sent.length = 0;
        await registry.dispatch({
            bot: { ...fakeBot, ipLookup: lookup },
            parsed: parseChatLine('<Steve> v:identity VojtaV12')
        });
        const parts = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);
        const text = parts.map(part => part.text).join('');

        assert.match(text, /VojtaV12 — 2f1d16b9/);
        assert.match(text, /whois/);
        assert.match(text, /ip: 246\.37\.222\.31/);
        assert.match(text, /gamemode: creative/);

        // Values carry colour, and a true flag is red rather than green.
        const ip = parts.find(part => part.text === '246.37.222.31');
        assert.strictEqual(ip.color, 'aqua');
        const op = parts.find(part => part.text === 'true');
        assert.strictEqual(op.color, 'red');
    });

    await check('the refill command toggles spam refills', refillCommandCheck);

    await check('trusted commands respond with identity data', async () => {
        const output = await run('<Steve> v:identity Alex');
        assert.match(output, /Alex — 069a79f4/);
        assert.match(output, /rank admin/);
        assert.match(output, /player list/);
    });

    await check('replies are private tellraw, never chat', async () => {
        sent.length = 0;
        await registry.dispatch({ bot: fakeBot, parsed: parseChatLine('<Unranked> v:help') });
        assert.match(sent[0], /^\/tellraw Unranked [[{]/);
        assert.match(decodeReply(sent[0]), /Commands \(\d+\)/);
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

        // Without a core, nothing is sent at all: chat is not a fallback.
        assert.strictEqual(routingBot.chat('/say hi'), false);
        assert.strictEqual(routingBot.chat('hello world'), false);
        assert.deepStrictEqual(spoken, [], 'the bot never talks in chat');

        const core = new Core({
            bot: routingBot,
            // Nothing of the bot's own is standing here: the fill goes out as
            // chat, one line at a time, because there is nothing else to run it.
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

        // Nothing is standing to run a fill in: the one way left is chat, and it
        // is one line, not one per retry.
        packets.length = 0;
        spoken.length = 0;
        core.refill('damaged');
        assert.strictEqual(spoken.length, 1, 'one chat fill');
        assert.match(spoken[0],
            /^\/fill -?\d+ -?\d+ -?\d+ -?\d+ -?\d+ -?\d+ minecraft:repeating_command_block( replace)?$/,
            'one fill, at the whole core or the mini core');
        assert.strictEqual(packets.length, 0, 'a refill is never routed back through the core');
        core.refill('damaged', { force: true });
        assert.strictEqual(spoken.length, 1, 'a fill is not repeated while the last one is out');
        core.destroy();
    });

    await check('colour codes in replies become components', () => {
        const { colorize } = require('../src/minecraft/tellraw');
        const parts = colorize('&aok &7- &c12ms');
        assert.deepStrictEqual(parts, [
            { text: 'ok ', color: 'green' },
            { text: '- ', color: 'gray' },
            { text: '12ms', color: 'red' }
        ]);
        assert.strictEqual(colorize('plain text'), null);

        sent.length = 0;
        registry.reply(fakeBot, 'Unranked', '&aDone &lbold');
        const payload = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);
        // A format code keeps the colour in effect, like in game.
        assert.deepStrictEqual(payload, [
            { text: 'Done ', color: 'green' },
            { text: 'bold', color: 'green', bold: true }
        ]);
    });

    await check('click tokens run an action as the player who clicked', async () => {
        const { ClickTokens } = require('../src/clicktokens');
        const clicks = new ClickTokens({ logger });
        const seen = [];
        const token = clicks.register('selftest', async clicker => seen.push(clicker));

        assert.match(token, /^\/random value \d+\.\.\d+$/);
        assert.ok(clicks.resolve(token), 'a fresh token resolves');

        assert.strictEqual(clicks.handle('Steve issued server command: Hans /random value 1..2'), false);
        assert.strictEqual(clicks.handle(`Steve issued server command: ${token}`), true);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepStrictEqual(seen.map(clicker => clicker.name), ['Steve']);

        // Unknown numbers do nothing, and a button source can be dropped.
        assert.strictEqual(clicks.handle('Steve issued server command: /random value 7..8'), false);
        assert.strictEqual(clicks.invalidate('selftest'), 1);
        assert.strictEqual(clicks.handle(`Steve issued server command: ${token}`), false);
        clicks.destroy();
    });

    await check('suggestions become working buttons automatically', async () => {
        const { ClickTokens } = require('../src/clicktokens');
        const clicks = new ClickTokens({
            logger,
            uuidFor: () => null,
            onCommand: (suggestion, clicker) => registry.dispatch({
                bot: { ...fakeBot, clickTokens: clicks },
                parsed: { username: clicker.name, message: suggestion, uuid: null },
                verified: false
            })
        });
        const clickBot = { ...fakeBot, clickTokens: clicks };

        sent.length = 0;
        await registry.dispatch({ bot: clickBot, parsed: parseChatLine('<Unranked> v:help') });
        const parts = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);

        const helpPart = parts.find(part => part.text === 'help');
        assert.ok(helpPart, 'help is listed');
        assert.strictEqual(helpPart.clickEvent.action, 'run_command', 'a suggestion becomes a button');
        assert.match(helpPart.clickEvent.value, /^\/random value \d+\.\.\d+$/);
        assert.ok(
            !parts.some(part => part.clickEvent?.action === 'suggest_command'),
            'nothing is left as a suggestion'
        );

        // Clicking opens that command's help as the player it was sent to.
        sent.length = 0;
        assert.strictEqual(clicks.handle(`Unranked issued server command: ${helpPart.clickEvent.value}`), true);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.match(decodeReply(sent[0]), /v:help \[command\]/);
        assert.match(decodeReply(sent[0]), /List the commands you can use/);

        clicks.destroy();
    });

    await check('a click token only answers for the player it was sent to', async () => {
        const { ClickTokens } = require('../src/clicktokens');
        const clicks = new ClickTokens({ logger, uuidFor: () => null });

        const ran = [];
        const token = clicks.register('help', player => ran.push(player.name), { player: 'Steve' });

        // Someone else naming the token is not the player it was issued to.
        assert.strictEqual(clicks.handle(`Alex issued server command: ${token}`), false);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepStrictEqual(ran, []);

        assert.strictEqual(clicks.handle(`Steve issued server command: ${token}`), true);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepStrictEqual(ran, ['Steve']);

        clicks.destroy();
    });

    await check('clicking a help entry opens that command\'s help as the clicker', async () => {
        const { ClickTokens } = require('../src/clicktokens');
        const clicks = new ClickTokens({
            logger,
            uuidFor: name => bot.uuidFor(name),
            onCommand: (suggestion, clicker) => registry.dispatch({
                bot: { ...fakeBot, clickTokens: clicks },
                parsed: { username: clicker.name, message: suggestion, uuid: clicker.uuid },
                verified: false,
                trustedClicker: true
            })
        });
        const clickBot = { ...fakeBot, clickTokens: clicks };

        sent.length = 0;
        await registry.dispatch({ bot: clickBot, parsed: parseChatLine('<VojtaV12> v:help') });
        const parts = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);

        const entryPart = parts.find(part => part.text === 'core');
        assert.ok(entryPart, 'the owner sees the core entry');
        assert.strictEqual(entryPart.clickEvent.action, 'run_command', 'the entry is a real button');

        // Clicking it runs help for that command, not the command itself.
        sent.length = 0;
        assert.strictEqual(clicks.handle(`VojtaV12 issued server command: ${entryPart.clickEvent.value}`), true);
        await new Promise(resolve => setTimeout(resolve, 20));
        const helpReply = decodeReply(sent[0]);
        assert.match(helpReply, /v:core \[status/);
        assert.match(helpReply, /Run a command through the core/);
        assert.match(helpReply, /\[public\]/, 'the clicker sees the rank of the command');

        // A button that runs a privileged command keeps the clicker's rank: an
        // owner is still the owner when they click.
        const statusBot = {
            ...clickBot,
            core: { miniStatusParts: () => [{ text: 'mini core ready', color: 'green' }] }
        };
        const statusToken = clicks.register('core', clicker => registry.dispatch({
            bot: statusBot,
            parsed: { username: clicker.name, message: 'v:core status', uuid: clicker.uuid },
            verified: false,
            trustedClicker: true
        }));

        sent.length = 0;
        clicks.handle(`VojtaV12 issued server command: ${statusToken}`);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.match(decodeReply(sent[0]), /mini core ready/);
        assert.ok(!/token/.test(decodeReply(sent[0])), 'an owner click is not asked for a token');

        clicks.destroy();
    });

    await check('core status, core and cb describe the mini core, not the main area', async () => {
        const core = new Core({
            bot: {
                client: { version: '1.20.4' },
                position: { x: 0, y: 70, z: 0 },
                write: () => true,
                chat: () => true,
                log: logger
            },
            config: {
                enabled: true,
                name: '{"text":"vbot","color":"green"}',
                area: { size: 2, y: 64 },
                refill: { enabled: true, miniSize: 3, miniName: '{"text":"minicore","color":"green"}' }
            },
            logger
        });
        core.reset({ x: 0, y: 70, z: 0 });
        assert.strictEqual(core.fillItem.side, 3, 'the cube is the size the config asks for');

        // One cell of the cube is shown by the server, so the status says so.
        const CMD_STATE = require('minecraft-data')('1.20.4').blocksByName.command_block.defaultState;
        core.fillItem.noteBlockChange({ location: { x: -1, y: 72, z: -1 }, type: CMD_STATE });

        const statusBot = { ...fakeBot, core };
        for (const text of ['v:core status', 'v:core', 'v:cb']) {
            sent.length = 0;
            await registry.dispatch({ bot: statusBot, parsed: parseChatLine(`<VojtaV12> ${text}`) });
            const line = decodeReply(sent[0]);
            assert.match(line, /mini core 3\^3/, `${text} says it is the mini core`);
            assert.match(line, /at -1 72 -1\.\.1 74 1/, `${text} says where the cube is`);
            assert.match(line, /1\/27 standing/, `${text} says how much of it stands`);
            assert.doesNotMatch(line, /2\^3 at 0 64 0/, `${text} does not describe the main area`);
        }

        // The name is the one the cube is filled with, with the gradient the
        // status line has always used.
        const parts = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);
        const name = parts.filter(part => part.color?.startsWith('#'));
        assert.strictEqual(name.map(part => part.text).join(''), 'minicore', 'the cube\'s own name is shown');

        core.destroy();
    });

    await check('ip parsing only accepts real addresses', () => {
        const { parseIps, parseUuid, looksLikeIp, lookupCommand } = require('../src/ip');
        assert.deepStrictEqual(parseIps('Steve joined from 1.2.3.4'), ['1.2.3.4']);
        assert.deepStrictEqual(parseIps('server version 1.21.4'), [], 'a version is not an address');
        assert.deepStrictEqual(parseIps('no address here'), []);

        // Servers that mask addresses keep the shape; it is still a bucket.
        assert.deepStrictEqual(parseIps('IP: 1.2.3.x'), ['1.2.3.x']);
        assert.deepStrictEqual(parseIps('IP: 1.2.3.**'), ['1.2.3.**']);
        assert.strictEqual(looksLikeIp('1.2.3.*'), true);
        assert.strictEqual(looksLikeIp('1.2.3.x'), true);
        assert.strictEqual(looksLikeIp('1.2.3.4'), true);
        assert.strictEqual(looksLikeIp('1.21.4'), false);
        assert.strictEqual(looksLikeIp('Steve'), false);
        // The real /whois reply, as the screenshot shows it.
        const whois = [
            '----- Whois: VojtaV12 -----',
            '- Nick: VojtaV12',
            '- UUID: 2f1d16b9-7337-31d7-997f-acaa527152d9',
            '- Location: (world, 29,999,955.1, 29,999,938)',
            '- Playtime: now',
            '- IP Address: /246.37.222.31',
            '- Speed: 0.2'
        ].join('\n');
        assert.deepStrictEqual(parseIps(whois), ['246.37.222.31'], 'the leading slash is not part of it');
        assert.strictEqual(parseUuid(whois), '2f1d16b9-7337-31d7-997f-acaa527152d9');

        assert.strictEqual(lookupCommand('seen {player}', 'Steve'), 'seen Steve');
        assert.strictEqual(lookupCommand('/seen {PLAYER}', 'Steve'), 'seen Steve');
        assert.strictEqual(lookupCommand('', 'Steve'), null);
    });

    await check('whois fields are read, and seen is the fallback', async () => {
        const { parseWhois } = require('../src/ip');
        const { IpLookup } = require('../src/iplookup');

        const whoisText = [
            '----- Whois: VojtaV12 -----',
            '- Nick: VojtaV12',
            '- UUID: 2f1d16b9-7337-31d7-997f-acaa527152d9',
            '- Health: 20/20',
            '- Hunger: 20/20 (+4 saturation)',
            '- Exp: 0 (Level 0)',
            '- Playtime: now',
            '- Money: $0',
            '- IP Address: /246.37.222.31',
            '- Gamemode: creative',
            '- God mode: false',
            '- OP: true',
            '- Fly mode: true (not flying)',
            '- Speed: 0.2',
            '- AFK: false',
            '- Muted: false',
            '- Location: (world, 29,999,955.1, 29,999,938)'
        ].join('\n');

        const fields = parseWhois(whoisText);
        assert.strictEqual(fields.nick, 'VojtaV12');
        assert.strictEqual(fields.ip, '246.37.222.31');
        assert.strictEqual(fields.gamemode, 'creative');
        assert.strictEqual(fields.hunger, '20/20 (+4 saturation)');
        assert.strictEqual(fields.op, 'true');
        assert.strictEqual(fields.uuid, '2f1d16b9-7337-31d7-997f-acaa527152d9');
        assert.ok(!('bad' in parseWhois('- Something else: 1')));

        // whois answers nothing, so seen is asked instead.
        const asked = [];
        const bot = {
            state: 'ready',
            online: new Map(),
            uuidFor: () => null,
            core: {
                ready: true,
                runTracked: async command => {
                    asked.push(command);
                    return command.startsWith('whois') ? null : 'FallbackGuy is 1.2.3.4';
                }
            }
        };
        const lookup = new IpLookup({
            bot,
            store,
            config: { lookupCommand: 'whois {player}', fallbackCommand: 'seen {player}' },
            logger
        });

        const result = await lookup.query('FallbackGuy');
        assert.deepStrictEqual(asked, ['whois FallbackGuy', 'seen FallbackGuy']);
        assert.deepStrictEqual(result.ips, ['1.2.3.4']);
        assert.strictEqual(result.source, 'seen {player}');
        lookup.destroy();
    });

    await check('viaver gives each player a last known version', async () => {
        const { parseViaver, VersionLookup } = require('../src/versions');

        const parker = '[Parker2991] UUID: 8575b68d-a667-3877-97b1-3cd78404bc9d9\n' +
            'Client protocol: 26.3 Server protocol: 26.3 Client: false';
        assert.deepStrictEqual(parseViaver(parker, 'Parker2991'), {
            name: 'Parker2991',
            client: '26.3',
            server: '26.3',
            viaClient: 'false'
        });

        const both = `${parker}\n[znq] UUID: 276f92b0-2e1d-8d9d-9d0d-3531bb562bf0\n` +
            'Client protocol: 1.21.4 Server protocol: 26.3 Client: false';
        assert.strictEqual(parseViaver(both, 'znq').client, '1.21.4', 'the name above the line picks it');
        assert.strictEqual(parseViaver(both, 'nobody'), null, 'never another player\'s line');
        assert.strictEqual(parseViaver('nothing here', 'Steve'), null);

        const asked = [];
        const versionBot = {
            state: 'ready',
            online: new Map([['steve', { name: 'Steve' }]]),
            core: {
                ready: true,
                runTracked: async (command, options) => {
                    asked.push({ command, options });
                    return 'Client protocol: 26.3 Server protocol: 26.3 Client: false';
                }
            }
        };
        const versions = new VersionLookup({ bot: versionBot, store, config: { gapMs: 5 }, logger });

        assert.strictEqual(versions.queue('Steve'), true);
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.deepStrictEqual(asked.map(entry => entry.command), ['viaver player Steve']);
        assert.strictEqual(store.getPlayer('Steve').version, '26.3', 'the version is kept on the player row');
        assert.strictEqual(versions.versionFor('Steve').version, '26.3');

        assert.strictEqual(versions.rescan(), 1, 'an online player is looked at again');
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.strictEqual(asked.length, 2, 'a rescan asks even though the cache has an answer');

        versions.destroy();
    });

    await check('every online player is rescanned on an interval', async () => {
        const { IpLookup } = require('../src/iplookup');
        const asked = [];
        const lookupBot = {
            state: 'ready',
            online: new Map([
                ['steve', { name: 'Steve', uuid: null }],
                ['alex', { name: 'Alex', uuid: null }]
            ]),
            core: {
                ready: true,
                runTracked: async command => {
                    asked.push(command);
                    return 'IP: 1.2.3.4';
                }
            },
            uuidFor: () => null
        };

        const scan = new IpLookup({
            bot: lookupBot,
            store,
            config: { lookupCommand: 'seen {player}', gapMs: 5 },
            logger
        });

        assert.strictEqual(scan.rescan(), 2, 'both online players are queued');
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.deepStrictEqual(asked.sort(), ['seen Alex', 'seen Steve']);

        // A whois reply also gives the uuid, which is stored when the player
        // list never supplied one.
        const whoisBot = {
            ...lookupBot,
            core: {
                ready: true,
                runTracked: async () => '- UUID: 2f1d16b9-7337-31d7-997f-acaa527152d9\n- IP Address: /246.37.222.31'
            }
        };
        const whois = new IpLookup({
            bot: whoisBot,
            store,
            config: { lookupCommand: 'whois {player}' },
            logger
        });
        assert.deepStrictEqual(await whois.lookup('WhoisGuy'), ['246.37.222.31']);
        assert.strictEqual(store.getPlayer('WhoisGuy').uuid, '2f1d16b9-7337-31d7-997f-acaa527152d9');
        assert.strictEqual(store.ipsFor('WhoisGuy')[0].ip, '246.37.222.31');
        whois.destroy();

        // A second rescan happens even though the answers are cached.
        asked.length = 0;
        assert.strictEqual(scan.rescan(), 2);
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.strictEqual(asked.length, 2, 'a rescan is not skipped by the cache');

        scan.destroy();
    });

    await check('alts links accounts through their addresses', async () => {
        store.recordIp('Steve', '1.2.3.4', offlineUuid('Steve'));
        store.recordIp('Alex', '1.2.3.4', offlineUuid('Alex'));
        store.recordIp('Alex', '5.6.7.8', offlineUuid('Alex'));

        const lookup = {
            usable: true,
            historyFor: name => store.ipsFor(name),
            ipFor: name => store.ipsFor(name)[0]?.ip ?? null,
            lookup: async () => ['1.2.3.4']
        };
        const altsBot = {
            ...fakeBot,
            ipLookup: lookup,
            online: new Map([['alex', { name: 'Alex', uuid: offlineUuid('Alex') }]])
        };

        const run = async message => {
            sent.length = 0;
            await registry.dispatch({ bot: altsBot, parsed: parseChatLine(message) });
            return decodeReply(sent[0]);
        };

        const playerView = await run('<VojtaV12> v:alts Steve');
        assert.match(playerView, /alts Steve/);
        assert.match(playerView, /1\.2\.3\.4/);
        assert.match(playerView, /Alex/, 'the other account on that address is listed');

        const ipView = await run('<VojtaV12> v:alts 5.6.7.8');
        assert.match(ipView, /1 account/);
        assert.match(ipView, /Alex/);
        assert.match(ipView, /online/, 'an online account is marked');

        // Public, like the reference bot's: anyone may look at a cluster.
        assert.match(await run('<Unranked> v:alts Steve'), /alts Steve — 1 address/);
    });

    await check('alts shows the last known version on a name hover', async () => {
        const alts = require('../src/commands/alts');

        store.recordIp('VersionGuy', '10.9.9.9');
        store.recordIp('VersionAlt', '10.9.9.9');
        store.recordVersion('VersionGuy', '26.3');
        store.recordVersion('VersionAlt', '1.21.4');

        let parts = null;
        const ctx = {
            args: ['VersionGuy'],
            prefix: 'v\\',
            store,
            reply: value => { parts = value; },
            bot: {
                online: new Map(),
                ipLookup: { usable: false, historyFor: name => store.ipsFor(name) },
                versions: {
                    versionFor: name => {
                        const player = store.getPlayer(name);
                        return player?.version ? { version: player.version, at: player.version_at } : null;
                    }
                }
            }
        };

        await alts.execute(ctx);

        const guy = parts.find(part => part && part.text === 'VersionGuy');
        assert.match(guy.hover.text, /last known version: 26\.3/);
        const alt = parts.find(part => part && part.text === 'VersionAlt');
        assert.match(alt.hover.text, /last known version: 1\.21\.4/, 'the other account shows its own');
        assert.doesNotMatch(alt.hover.text, /26\.3/);
    });

    await check('the tab list tracks who is online, not just who was seen', () => {
        bot.online.clear();
        bot.known.clear();

        // 1.19.3+ shape: the name lives under "player".
        bot.handlePlayerInfo({
            actions: ['add_player'],
            entries: [
                { uuid: offlineUuid('Tabby'), player: { name: 'Tabby' } },
                { uuid: offlineUuid('Tabbo'), player: { name: 'Tabbo' } }
            ]
        });
        assert.strictEqual(bot.online.size, 2, 'both players are online');

        // A reconnect repeats the same names; they must stay listed even though
        // their identity is already known.
        bot.handlePlayerInfo({
            actions: ['add_player'],
            entries: [{ uuid: offlineUuid('Tabby'), player: { name: 'Tabby' } }]
        });
        assert.strictEqual(bot.online.size, 2, 'already known players are still online');

        // Older protocol: removal arrives as action 4.
        bot.handlePlayerInfo({ action: 4, data: [{ uuid: offlineUuid('Tabbo'), name: 'Tabbo' }] });
        assert.deepStrictEqual([...bot.online.keys()], ['tabby']);

        // 1.19.3+ hides a player with update_listed and a uuid only.
        bot.handlePlayerInfo({
            actions: ['update_listed'],
            entries: [{ uuid: offlineUuid('Tabby'), listed: false }]
        });
        assert.strictEqual(bot.online.size, 0, 'a hidden player leaves the list');
        bot.online.clear();
    });

    await check('the selector scan finds players the tab list hides', async () => {
        bot.online.clear();
        bot.listed.clear();

        bot.handlePlayerInfo({
            actions: ['add_player'],
            entries: [
                { uuid: offlineUuid('ScanA'), player: { name: 'ScanA' } },
                { uuid: offlineUuid('ScanB'), player: { name: 'ScanB' } }
            ]
        });

        // ScanB vanishes: the tab list drops them, the selector still sees them.
        bot.handlePlayerInfo({
            actions: ['update_listed'],
            entries: [{ uuid: offlineUuid('ScanB'), listed: false }]
        });
        assert.ok(!bot.online.has('scanb'), 'a hidden player leaves the tab list');

        assert.strictEqual(bot.notePlayerList('[PLAYER_LIST] ScanA, ScanB'), true);
        assert.deepStrictEqual([...bot.online.keys()].sort(), ['scana', 'scanb']);

        // Command spy echoes the command itself; that payload is not a player.
        const before = bot.online.size;
        assert.strictEqual(bot.notePlayerList(
            'vbot issued server command: /tellraw vbot {"text":"[PLAYER_LIST]","extra":[{"selector":"@a"}]}'
        ), false);
        assert.strictEqual(bot.online.size, before, 'the tellraw payload is not a name list');
        assert.strictEqual(bot.online.get('scanb').vanished, true);
        assert.strictEqual(bot.online.get('scana').vanished, false);

        // The scan is sent to the bot alone, and asks @a who is there.
        const scans = [];
        const scanBot = new Bot({
            server: { id: 'scan', host: '127.0.0.1', port: 1, username: 'vbot', auth: 'offline' },
            config,
            store,
            permissions,
            registry: { dispatch: async () => {} },
            logger
        });
        scanBot.state = 'ready';
        scanBot.chat = message => (scans.push(message), true);
        assert.strictEqual(scanBot.scanOnline(), true);
        assert.match(scans[0], /^\/tellraw vbot /, 'the slash is what makes it a command');
        assert.match(scans[0], /"selector":"@a"/);
        scanBot.destroy();

        // With a core up, the same scan is written into a block instead of chat.
        const routed = [];
        const routedBot = new Bot({
            server: { id: 'routed', host: '127.0.0.1', port: 1, username: 'vbot', auth: 'offline' },
            config,
            store,
            permissions,
            registry: { dispatch: async () => {} },
            logger
        });
        routedBot.state = 'ready';
        routedBot.client = { chat: message => (scans.push(message), true) };
        routedBot.core = {
            ready: true,
            run: command => (routed.push(command), { x: 0, y: 0, z: 0 }),
            destroy: () => {}
        };
        scans.length = 0;
        assert.strictEqual(routedBot.scanOnline(), true);
        assert.deepStrictEqual(scans, [], 'the scan must not go out as chat');
        assert.match(routed[0], /^tellraw vbot /);
        routedBot.destroy();

        // And the listing shows the vanished player rather than hiding them.
        sent.length = 0;
        await registry.dispatch({
            bot: { ...fakeBot, online: bot.online },
            parsed: parseChatLine('<Unranked> v:list')
        });
        const listing = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);
        const text = listing.map(part => part.text).join('');
        assert.match(text, /ScanB/);
        assert.match(text, /\(vanish\)/);
        assert.match(text, /1 vanished/);

        bot.online.clear();
        bot.listed.clear();
    });

    await check('list pages through the players the tab list reported', async () => {
        const online = new Map();
        for (let index = 0; index < 10; index++) {
            const name = `Player${index}`;
            online.set(name.toLowerCase(), { name, uuid: offlineUuid(name) });
        }
        const { ClickTokens } = require('../src/clicktokens');
        const clicks = new ClickTokens({ logger, uuidFor: () => null, onCommand: () => {} });
        const listBot = {
            ...fakeBot,
            online,
            clickTokens: clicks,
            ipLookup: { ipFor: () => '1.2.3.4' }
        };

        const show = async message => {
            sent.length = 0;
            await registry.dispatch({ bot: listBot, parsed: parseChatLine(message) });
            return JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);
        };

        const first = await show('<Unranked> v:list');
        const text = parts => parts.map(part => part.text).join('');
        assert.match(text(first), /Online \(10/, 'the header counts everyone');
        assert.match(text(first), /page 1\/2|\(10, page 1\/2\)/);
        // One page of eight: each UUID copies itself, each name opens its addresses.
        assert.strictEqual(first.filter(part => part.clickEvent?.action === 'copy_to_clipboard').length, 8);
        assert.strictEqual(first.filter(part => part.text === ' - ').length, 8);
        const nameButton = first.find(part => part.text === 'Player1');
        assert.strictEqual(nameButton.clickEvent.action, 'run_command', 'the name is a button');

        // The name hover carries the uuid and the address together.
        const firstRow = first.find(part => part.text === 'Player0');
        assert.ok(firstRow, 'the first player is listed');
        assert.match(firstRow.hoverEvent.contents.text, /ip: 1\.2\.3\.4/);
        assert.match(firstRow.hoverEvent.contents.text, new RegExp(offlineUuid('Player0')));

        // The arrow is a suggestion, which the registry turns into a real button.
        const next = first.find(part => part.text === ' ▶');
        assert.ok(next, 'a next arrow is offered');
        assert.strictEqual(next.clickEvent.action, 'run_command');
        assert.match(next.hoverEvent.contents.text, /Next page/);

        const second = await show('<Unranked> v:players 2');
        assert.match(text(second), /Player9/);
        assert.match(text(second), /page 2\/2/);

        // Out of range lands on the last page instead of an empty reply.
        assert.match(text(await show('<Unranked> v:list 99')), /page 2\/2/);
        clicks.destroy();

        // An empty tab list says so.
        listBot.online = new Map();
        sent.length = 0;
        await registry.dispatch({ bot: listBot, parsed: parseChatLine('<Unranked> v:list') });
        assert.match(decodeReply(sent[0]), /No players online/);
    });

    await check('uuid and whoami commands answer', async () => {
        assert.match(await run('<Steve> v:uuid Notch'), /offline: [0-9a-f-]{36}/);
        assert.match(await run('<Steve> v:whoami'), /You are admin/);
        assert.match(await run('<Steve> v:ping'), /pong/);
    });


    await check('a core block broken to air is refilled at once', () => {
        const sent = [];
        const bot = {
            client: { write: (name, packet) => sent.push({ name, packet }) },
            chat: () => false,
            position: { x: 0, y: 64, z: 0 }
        };
        const core = new Core({
            bot,
            config: { enabled: true, area: { size: 9, y: 64 }, refill: { enabled: true, intervalMs: 60_000 } },
            logger
        });
        core.origin = { x: 1, y: 64, z: 1 };
        core.bounds = { x: 9, y: 72, z: 9 };
        core.blocks.set('1:64:1', true);
        // A standing core: the fill has landed, so a break is real damage.
        core.ready = true;

        assert.strictEqual(core.onBlockChange({ location: { x: 1, y: 64, z: 1 }, type: 0 }), true);
        assert.strictEqual(core.damageTimer, null, 'air is an instant refill, not a delayed damage refill');
        const wrote = sent.some(write => write.name === 'update_command_block') || core.refilling;
        assert.ok(wrote, 'a refill was started right away');
    });

    await check('spam refill stays off unless auto is turned on', () => {
        const make = (auto) => {
            const bot = {
                client: { write: () => {} },
                chat: () => false,
                position: { x: 0, y: 64, z: 0 }
            };
            const core = new Core({
                bot,
                config: { enabled: true, area: { size: 9, y: 64 }, refill: { enabled: true, auto } },
                logger
            });
            core.origin = { x: 1, y: 64, z: 1 };
            core.startWatchdog = () => {};
            core.refill = () => true;
            return core;
        };

        const off = make(false);
        off.onReady();
        assert.strictEqual(off.spamTimer, null);

        const implicit = make(undefined);
        implicit.onReady();
        assert.strictEqual(implicit.spamTimer, null);
    });

    await check('core moves its area when the bot is teleported away', () => {
        const writes = [];
        const core = new Core({
            bot: {
                position: { x: 1000, y: 70, z: 1000 },
                chat: () => true,
                write: (name, payload) => (writes.push({ name, payload }), true),
                log: logger
            },
            config: { enabled: true, area: { size: 2, y: 64 }, refill: { enabled: true } },
            logger
        });
        core.reset({ x: 1000, y: 70, z: 1000 });
        core.ready = true;
        core.markAllAlive();

        // The bot was teleported far away: command blocks in the old chunk do not
        // tick, so the area moves to where it stands now instead of refusing
        // every command for the rest of the session.
        core.bot.position = { x: 5000, y: 70, z: 5000 };
        assert.deepStrictEqual(core.run('say hi'), { x: 5000, y: 64, z: 5000 });
        assert.strictEqual(core.origin.x, 5000, 'the grid followed the bot');
        assert.strictEqual(core.origin.z, 5000);
        const placed = writes.filter(write => write.name === 'update_command_block');
        assert.strictEqual(placed[placed.length - 1].payload.command, 'say hi');

        // Back where it started: the grid follows again rather than writing into
        // blocks that are thousands of blocks away.
        core.bot.position = { x: 1000, y: 70, z: 1000 };
        assert.deepStrictEqual(core.run('say again'), { x: 1000, y: 64, z: 1000 });
        assert.strictEqual(core.origin.x, 1000, 'the grid followed the bot back');

        // A loaded area stays put: only a mismatch moves the grid.
        assert.ok(core.run('say third'));
        assert.strictEqual(core.origin.x, 1000);
        core.destroy();
        core.destroy();
    });

    await check('core picks up chunk and bulk damage', () => {
        const core = new Core({
            bot: {
                position: { x: 0, y: 70, z: 0 },
                client: { version: '1.21.4' },
                chat: () => true,
                write: () => true,
                log: logger
            },
            config: { enabled: true, area: { size: 2, y: 64 }, refill: { enabled: true } },
            logger
        });
        core.reset({ x: 0, y: 70, z: 0 });
        core.ready = true;
        core.graceUntil = 0;
        core.lastRefillAt = 0;
        core.markAllAlive();

        // A chunk resend with no command blocks in the area is bulk damage: an
        // empty chunk is air everywhere.
        const Chunk = require('prismarine-chunk')('1.21.4');
        const chunkData = new Chunk().dump();
        assert.strictEqual(core.onMapChunk({ x: 0, z: 0, chunkData }), true, 'an empty core chunk is damage');

        // A section y of 4 is block y 64; a zero record is local (0,0,0).
        // The chunk refill above started, so put the core back in its normal
        // standing state before the next packet.
        core.refilling = false;
        core.ready = true;
        core.graceUntil = 0;
        core.ownChanges.clear();
        core.markAllAlive();
        const changed = core.onMultiBlockChange({
            chunkCoordinates: { x: 0, y: 4, z: 0 },
            records: [0]
        });
        assert.strictEqual(changed, true, 'a core block in a bulk update is damage');
        assert.strictEqual(core.blocks.get('0:64:0'), false);

        // A record in another chunk is not our damage.
        core.refilling = false;
        core.ready = true;
        core.graceUntil = 0;
        core.ownChanges.clear();
        assert.strictEqual(core.onMultiBlockChange({
            chunkCoordinates: { x: 4, y: 4, z: 4 },
            records: [0]
        }), false);
        core.destroy();
    });

    await check('a mini core emptied without a block update is filled again', () => {
        const writes = [];
        const miniBot = {
            client: { version: '1.21.4' },
            position: { x: 10.7, y: 64, z: -3.2 },
            write: (name, payload) => (writes.push({ name, payload }), true)
        };
        const CMD_STATE = require('minecraft-data')('1.21.4').blocksByName.command_block.defaultState;
        const core = new Core({
            bot: miniBot,
            config: { enabled: true, area: { size: 9, y: 64 }, refill: { enabled: true } },
            logger
        });
        // The area is beside the bot, not around it, so only the mini core is
        // under test here.
        core.origin = { x: 0, y: 64, z: 0 };
        core.bounds = { x: 8, y: 72, z: 8 };
        core.ready = true;
        core.graceUntil = 0;
        core.markAllAlive();

        const mini = core.fillItem;
        const stand = () => {
            for (const cell of mini.current().cells) {
                mini.noteBlockChange({ location: { ...cell }, type: CMD_STATE });
            }
        };
        mini.fillCommand();
        stand();
        assert.strictEqual(mini.cells().length, 8, 'the mini core stands');

        // A bulk update that turns one of the cells to air: no block update of its
        // own ever arrives, so the packet is all the bot has.
        const first = mini.cells()[0];
        const record = ((first.x & 15) << 8) | ((first.z & 15) << 4) | (first.y & 15);
        assert.strictEqual(core.onMultiBlockChange({
            chunkCoordinates: { x: first.x >> 4, y: first.y >> 4, z: first.z >> 4 },
            records: [record]
        }), true, 'a mini block that went to air is noticed');
        assert.strictEqual(mini.cells().length, 7, 'that cell is free again');
        // A lost cell fills the cube again where it stands, so the next bulk edit
        // is looked at once that fill has settled.
        assert.strictEqual(core.refilling, true, 'a missing cell is filled again at once');
        core.refilling = false;
        core.ready = true;
        core.graceUntil = 0;

        // A chunk resend with nothing in it says the same about the rest.
        const rest = mini.cells()[0];
        const Chunk = require('prismarine-chunk')('1.21.4');
        assert.strictEqual(
            core.onMapChunk({ x: rest.x >> 4, z: rest.z >> 4, chunkData: new Chunk().dump() }),
            true,
            'a resent chunk without the block is noticed'
        );
        assert.strictEqual(mini.cells().length, 0, 'nothing is left standing');

        // The next refill fills the cube again - through a core block of the area
        // that is still standing - instead of writing into air.
        writes.length = 0;
        core.lastRefillAt = 0;
        core.refilling = false;
        core.everReady = true;
        mini.flushedAt = 0;
        core.refill('damaged', { force: true });
        assert.strictEqual(writes.filter(write => write.name === 'block_place').length, 0,
            'nothing is placed by hand any more');
        assert.ok(writes.some(write => write.name === 'update_command_block'
            && /^fill .*(minecraft:)?repeating_command_block( replace)?$/.test(write.payload.command)),
        'the cube is filled again');
        stand();
        assert.strictEqual(mini.cells().length, 8);

        // A deletion that sends nothing at all is only found by asking: the answer
        // says the cell is not a command block, so the cube is dropped.
        assert.strictEqual(core.probe('item', mini.cells()[0]), true);
        const silent = writes.filter(write => write.name === 'query_block_nbt').pop();
        assert.deepStrictEqual(silent.payload.location, mini.cells()[0], 'it asks about the block it stands on');
        core.onQueryResponse({ transactionId: silent.payload.transactionId, nbt: null });
        assert.strictEqual(mini.cells().length, 0, 'a silent deletion drops the whole cube');

        // A block that is still there is kept and counted as standing.
        stand();
        core.probe('item', mini.cells()[0]);
        const standing = writes.filter(write => write.name === 'query_block_nbt').pop();
        core.onQueryResponse({
            transactionId: standing.payload.transactionId,
            nbt: { type: 'compound', value: { id: { type: 'string', value: 'minecraft:command_block' } } }
        });
        assert.strictEqual(mini.cells().length, 8, 'a standing block is kept');

        // The same question covers the main area, and a block that is gone refills it.
        core.refilling = false;
        core.graceUntil = 0;
        core.probe('core', { x: 0, y: 64, z: 0 });
        const forCore = writes.filter(write => write.name === 'query_block_nbt').pop();
        core.onQueryResponse({ transactionId: forCore.payload.transactionId, nbt: null });
        assert.strictEqual(core.blocks.get('0:64:0'), false, 'the cell is marked dead');
        assert.strictEqual(core.refilling, true, 'and the area is filled again');

        // The watchdog is what asks, so it has to pick a block to ask about.
        core.refilling = false;
        core.ready = true;
        core.graceUntil = 0;
        core.lastProbeAt = 0;
        writes.length = 0;
        assert.strictEqual(core.probeBlocks(), true, 'the watchdog has something to ask about');
        assert.strictEqual(writes.filter(write => write.name === 'query_block_nbt').length, 2,
            'one for the mini core, one for the area');
        for (const write of writes.filter(entry => entry.name === 'query_block_nbt')) {
            core.onQueryResponse({ transactionId: write.payload.transactionId, nbt: null });
        }
        core.destroy();
    });


    await check('command loops persist and run through the core', async () => {
        const { Cloops } = require('../src/cloops');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-cloop-'));
        const runs = [];
        const bot = {
            id: 'loop',
            destroyed: false,
            core: { run: command => (runs.push(command), { x: 0, y: 64, z: 0 }) }
        };
        const cloops = new Cloops({
            bot,
            storePath: path.join(dir, 'cloops.json'),
            logger,
            config: { enabled: true, minIntervalMs: 50 }
        });

        assert.deepStrictEqual(cloops.add(60, 'say hi'), { id: 1, interval: 60, command: 'say hi' });
        assert.strictEqual(cloops.add(10, 'say fast'), null, 'an interval under the minimum is refused');
        assert.strictEqual(cloops.add(100, ''), null);

        // A second reader loads it from disk, so restarts keep the loops.
        const again = new Cloops({
            bot,
            storePath: path.join(dir, 'cloops.json'),
            logger,
            config: { enabled: true, minIntervalMs: 50 }
        });
        assert.deepStrictEqual(again.list(), [{ id: 1, interval: 60, command: 'say hi' }]);

        cloops.start();
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.ok(runs.length >= 1, 'the loop runs through the core');
        assert.ok(runs.every(command => command === 'say hi'));

        assert.strictEqual(cloops.remove(1).id, 1);
        assert.deepStrictEqual(cloops.list(), []);
        cloops.destroy();
        again.destroy();
    });

    await check('discord bridge formats both directions', () => {
        const {
            discordComponent,
            channelFor,
            createDiscordBridge,
            stripMarkdown,
            takeBatch
        } = require('../src/discord');

        assert.strictEqual(
            discordComponent({ author: 'Alex', message: 'hello' }).map(part => part.text).join(''),
            '[Discord] Alex: hello'
        );
        assert.strictEqual(
            discordComponent({ author: 'Alex', message: 'hello', replyTo: 'Sam' })
                .map(part => part.text).join(''),
            '[Discord] Alex (reply to @Sam): hello'
        );
        assert.strictEqual(stripMarkdown('**bold** and `code`'), 'bold and code');
        assert.deepStrictEqual(takeBatch(['a', 'b', 'c']), { content: 'a\nb\nc', consumed: 3 });
        assert.strictEqual(
            channelFor({ discord: { channels: { kbpw: '123' } } }, { id: 'kbpw' }),
            '123'
        );
        assert.strictEqual(channelFor({}, { id: 'x', channelId: '456' }), '456');
        assert.strictEqual(channelFor({}, { id: 'x' }), null);

        // Disabled (or tokenless) Discord must not start a client or throw.
        assert.strictEqual(
            createDiscordBridge({ config: { discord: { enabled: false } }, manager: null, logger }),
            null
        );
        const bridge = createDiscordBridge({
            config: { bot: {}, discord: { enabled: true, token: '' } },
            manager: null,
            logger
        });
        assert.ok(bridge);
        assert.strictEqual(bridge.start(), false, 'no token means no client');
    });

    await check('discord roles decide which commands run', async () => {
        const { DiscordBridge } = require('../src/discord');

        const member = roles => ({ roles: { cache: new Map(roles.map(role => [role, {}])) } });
        const bridge = new DiscordBridge({
            config: { bot: {}, discord: { trustedId: 'T', adminId: 'A', ownerId: 'O', adminIds: ['U'] } },
            manager: null,
            logger
        });

        assert.strictEqual(bridge.rankFor(member([])), LEVEL.PUBLIC);
        assert.strictEqual(bridge.rankFor(member(['T'])), LEVEL.TRUSTED);
        assert.strictEqual(bridge.rankFor(member(['A'])), LEVEL.ADMIN);
        assert.strictEqual(bridge.rankFor(member(['O'])), LEVEL.OWNER);
        assert.strictEqual(bridge.rankFor({ roles: { cache: new Map() }, user: { id: 'U' } }), LEVEL.OWNER);
        assert.strictEqual(bridge.rankFor(null), LEVEL.PUBLIC);

        const registry = {
            manager: { bots: new Map() },
            store: {},
            permissions: {},
            find: label => ({
                filter: { name: 'filter', level: LEVEL.ADMIN, execute: async ctx => ctx.reply(`filter ${ctx.argString}`) },
                cloop: { name: 'cloop', level: LEVEL.TRUSTED, execute: async ctx => ctx.reply('cloop ok') },
                servers: { name: 'servers', level: LEVEL.PUBLIC, execute: async ctx => ctx.reply([{ text: 'ok' }, { text: '!' }]) }
            })[label] || null,
            runCommand: () => true
        };
        const runner = new DiscordBridge({
            config: { bot: { prefixes: ['v\\'] }, discord: { trustedId: 'T', adminId: 'A', ownerId: 'O' } },
            manager: null,
            logger,
            registry
        });
        const bot = { id: 'kbpw', state: 'ready', server: {}, online: new Map(), client: {}, chat: () => true };

        const denied = await runner.executeCommand(bot, member([]), 'filter add Steve');
        assert.strictEqual(denied.ok, false);
        assert.match(denied.text, /needs admin/);

        // Trusted is exactly vbot's trusted level: trusted commands pass,
        // admin-only commands do not.
        const trustedFilter = await runner.executeCommand(bot, member(['T']), 'filter add Steve');
        assert.strictEqual(trustedFilter.ok, false);
        assert.match(trustedFilter.text, /needs admin/);

        const trustedLoop = await runner.executeCommand(bot, member(['T']), 'cloop list');
        assert.strictEqual(trustedLoop.text, 'cloop ok');

        const allowed = await runner.executeCommand(bot, member(['A']), 'filter add Steve');
        assert.strictEqual(allowed.text, 'filter add Steve');

        const publicOnly = await runner.executeCommand(bot, member([]), 'v\\servers');
        assert.strictEqual(publicOnly.text, 'ok!');

        const unknown = await runner.executeCommand(bot, member(['A']), 'nope');
        assert.strictEqual(unknown.ok, false);
    });

    await check('discord sudo runs the command as that player', async () => {
        const { DiscordBridge } = require('../src/discord');

        const calls = [];
        const storedUuid = '11111111-2222-3333-4444-555555555555';
        const registry = {
            store: {
                getPlayer: name => (String(name).toLowerCase() === 'vojtav12'
                    ? { name: 'VojtaV12', uuid: storedUuid, first_seen: 0, last_seen: 0 }
                    : null)
            },
            permissions: {},
            dispatch: async request => {
                calls.push(request);
                request.sink?.('You are at 12 70 -4');
                return true;
            }
        };
        const bridge = new DiscordBridge({ config: { bot: {} }, manager: null, logger, registry });
        const bot = { id: 'kbpw', state: 'ready', uuidFor: () => 'offline-uuid', chat: () => true };

        const result = await bridge.sudoCommand(bot, 'VojtaV12', 'rtp');
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.text, 'You are at 12 70 -4', 'the output comes back to discord');

        const request = calls[0];
        assert.strictEqual(request.parsed.username, 'VojtaV12', 'it runs as the player');
        assert.strictEqual(request.parsed.uuid, storedUuid, 'their stored uuid, so whoami and seen answer');
        assert.strictEqual(request.parsed.message, 'rtp');
        assert.strictEqual(request.raw, true, 'the text is the command, with no prefix');
        assert.strictEqual(request.verified, true);
        assert.strictEqual(request.real, true, 'their stored rank is what runs');

        // A player with no record keeps the name as typed and falls back to the
        // bot's own uuid lookup.
        calls.length = 0;
        await bridge.sudoCommand(bot, 'Nobody', 'whoami');
        assert.strictEqual(calls[0].parsed.username, 'Nobody');
        assert.strictEqual(calls[0].parsed.uuid, 'offline-uuid');

        assert.strictEqual((await bridge.sudoCommand(bot, 'not a name!', 'rtp')).ok, false);
        assert.strictEqual((await bridge.sudoCommand(bot, 'Steve', '   ')).ok, false);
        assert.strictEqual((await bridge.sudoCommand({ id: 'x', state: 'offline' }, 'Steve', 'rtp')).ok, false);
    });

    await check('chat is relayed as an ansi code block', async () => {
        const { DiscordBridge, ansiBlock, toDiscordAnsi } = require('../src/discord');
        const { chatEventFromPacket } = require('../src/minecraft/chat');

        assert.strictEqual(ansiBlock('a\nb'), '```ansi\na\nb\n```');
        // 24-bit colour goes to Discord untouched, not reduced to sixteen.
        assert.strictEqual(toDiscordAnsi('\x1b[38;2;255;255;85mx'), '\x1b[38;2;255;255;85mx');

        const event = chatEventFromPacket('player_chat', {
            senderName: { text: 'Alex' },
            plainMessage: 'hi there'
        });
        assert.strictEqual(event.line, '<Alex> hi there');
        assert.strictEqual(event.ansi, '<Alex> hi there');

        const posted = [];
        const bot = {
            id: 'kbpw',
            state: 'ready',
            server: { username: 'Bot', channelId: '111' },
            online: new Map(),
            client: {},
            chat: () => true
        };
        const bridge = new DiscordBridge({
            config: {
                bot: { prefixes: ['v\\'] },
                discord: { enabled: true, token: 'x', relay: { chat: true, discord: true } }
            },
            manager: { list: () => [bot], on() {}, removeListener() {} },
            logger
        });
        bridge.client = {
            isReady: () => true,
            channels: { cache: new Map([['111', { send: async message => { posted.push(message); } }]]) }
        };
        bridge.started = true;
        bridge.buildRelays();

        assert.strictEqual(event.username, 'Alex');
        bridge.handleMinecraftChat(bot, {
            ...event,
            parsed: { username: event.username, message: event.message }
        });
        await bridge.flush(bridge.relays.get('kbpw'));

        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].content, '```ansi\n<Alex> hi there\n```');
        assert.deepStrictEqual(posted[0].allowedMentions, { parse: [] });

        // System chat, tellraw and command output are relayed with their colour.
        bridge.handleMinecraftChat(bot, chatEventFromPacket('system_chat', {
            content: { text: 'oDpPuqfKKNGT6g left the game', color: 'yellow' }
        }));
        bridge.handleMinecraftChat(bot, chatEventFromPacket('system_chat', {
            content: { text: 'There are 3 of a max of 20 players online', color: 'gray' }
        }));
        await bridge.flush(bridge.relays.get('kbpw'));

        assert.strictEqual(posted.length, 2, 'system lines do reach the channel');
        assert.strictEqual(
            posted[1].content,
            '```ansi\n\x1b[38;2;255;255;85moDpPuqfKKNGT6g left the game\x1b[0m\n' +
            '\x1b[38;2;170;170;170mThere are 3 of a max of 20 players online\x1b[0m\n```'
        );

        // The server can repeat a line; the same text is only posted once.
        bridge.handleMinecraftChat(bot, chatEventFromPacket('system_chat', {
            content: { text: 'oDpPuqfKKNGT6g left the game', color: 'yellow' }
        }));
        await bridge.flush(bridge.relays.get('kbpw'));
        assert.strictEqual(posted.length, 2, 'duplicate lines are dropped');

        // Discord -> Minecraft is a tellraw, and its echo stays out of Discord.
        const sent = [];
        bot.chat = text => (sent.push(text), true);
        await bridge.handleDiscordMessage({
            guild: {},
            author: { bot: false, username: 'Alex', id: '1', tag: 'alex' },
            member: { displayName: 'Alex' },
            channelId: '111',
            content: 'yo from **discord**'
        });

        assert.strictEqual(sent.length, 1);
        assert.match(sent[0], /^\/tellraw @a /);
        assert.match(sent[0], /yo from discord/);
        assert.ok(!sent[0].includes('**'), 'markdown is stripped before it reaches chat');

        // The tellraw the bridge sent is part of the in-game feed, so it shows
        // up in the channel too.
        bridge.handleMinecraftChat(bot, chatEventFromPacket('system_chat', {
            content: { text: '[Discord] Alex: yo from discord', color: '#55aaff' }
        }));
        await bridge.flush(bridge.relays.get('kbpw'));

        assert.strictEqual(posted.length, 3, 'the tellraw is relayed back');
        assert.match(posted[2].content, /\[Discord\] Alex: yo from discord/);

        bridge.destroy();
    });

    await check('a server line keeps the sender the packet names', () => {
        const { chatEventFromPacket } = require('../src/minecraft/chat');

        // Profileless chat is how a server sends `/say` and other non-player
        // lines: the message is only the message, the sender is beside it.
        const said = chatEventFromPacket('profileless_chat', {
            message: { text: 'hello there' },
            type: { chatType: 0, name: { text: 'Server' }, targetName: null },
            name: { text: 'Server' },
            target: null
        });
        assert.strictEqual(said.line, '[Server] hello there');
        assert.strictEqual(said.ansi, '[Server] hello there');
        assert.strictEqual(said.username, '', 'a server line is not a player');
        assert.strictEqual(said.verified, false);

        // Disguised chat names it in senderName instead.
        assert.strictEqual(
            chatEventFromPacket('disguised_chat', {
                message: { text: 'hi' },
                senderName: { text: 'Console' }
            }).line,
            '[Console] hi'
        );

        // Vanilla /say already has the name in the message: it is not added twice.
        assert.strictEqual(
            chatEventFromPacket('system_chat', {
                content: { translate: 'chat.type.announcement', with: ['Server', 'hello there'] }
            }, { 'chat.type.announcement': '[%s] %s' }).line,
            '[Server] hello there'
        );
    });

    await check('translate keys become sentences', () => {
        const { flatten, toAnsi } = require('../src/minecraft/text');
        const { chatEventFromPacket } = require('../src/minecraft/chat');

        const lang = { 'advMode.setCommand.success': 'Command set: %s' };
        const component = {
            translate: 'advMode.setCommand.success',
            with: [{ text: 'whois 9Pon4Inkr7Kn' }]
        };

        assert.strictEqual(flatten(component, lang), 'Command set: whois 9Pon4Inkr7Kn');
        // No table means the key, the way a client shows a missing string.
        assert.strictEqual(flatten(component), 'advMode.setCommand.successwhois 9Pon4Inkr7Kn');

        const event = chatEventFromPacket('system_chat', { content: component }, lang);
        assert.strictEqual(event.line, 'Command set: whois 9Pon4Inkr7Kn');

        assert.strictEqual(
            toAnsi({ ...component, color: 'gray' }, lang),
            '\x1b[38;2;170;170;170mCommand set: whois 9Pon4Inkr7Kn\x1b[0m'
        );

        // The real en_us table that ships with minecraft-data resolves the key
        // the server actually sends.
        const { languageFor } = require('../src/minecraft/chat');
        const real = languageFor('1.20.1');
        assert.strictEqual(
            chatEventFromPacket('system_chat', { content: component }, real).line,
            'Command set: whois 9Pon4Inkr7Kn'
        );

        // Legacy § colours become ANSI so they survive into Discord.
        assert.strictEqual(
            toAnsi({ text: '\u00a76Gold \u00a7rwhite' }),
            '\x1b[38;2;255;170;0mGold \x1b[0mwhite\x1b[0m'
        );

        // Styles reach the line too, inherited by the parts that do not set them.
        assert.strictEqual(
            toAnsi({ text: 'rank', bold: true, color: 'red', extra: [{ text: ' name', underlined: true }] }),
            '\x1b[38;2;255;85;85m\x1b[1mrank\x1b[38;2;255;85;85m\x1b[1m\x1b[4m name\x1b[0m'
        );

        // Some servers send the format itself as the translate key.
        assert.strictEqual(
            flatten({
                translate: '[%s] %s › %s',
                with: [{ text: 'kbpw' }, { text: 'ChomeNS' }, { text: 'tienda?' }]
            }, lang),
            '[kbpw] ChomeNS › tienda?'
        );

        // Indexed placeholders are used by a few messages.
        assert.strictEqual(
            flatten({ translate: 'multiplayer.player.joined', with: [{ text: 'Alex' }] }, {
                'multiplayer.player.joined': '%s joined the game'
            }),
            'Alex joined the game'
        );
    });

    await check('player chat relays the message, not the rank prefix', () => {
        const { chatEventFromPacket } = require('../src/minecraft/chat');

        // Some servers put the decorated display name in `message`; only the
        // message component belongs in the body.
        const event = chatEventFromPacket('player_chat', {
            senderName: { text: 'VojtaV12' },
            plainMessage: 'hello there',
            message: { text: '[OP] VojtaV12', color: 'gray' },
            unsignedChatContent: { text: 'hello there', color: 'yellow' }
        });

        assert.strictEqual(event.line, '<VojtaV12> hello there');
        // The server's own grey prefix and yellow body, not a colour of ours.
        assert.strictEqual(
            event.ansi,
            '\x1b[38;2;170;170;170m[OP] VojtaV12\x1b[0m \x1b[38;2;255;255;85mhello there\x1b[0m'
        );

        const plain = chatEventFromPacket('player_chat', {
            senderName: { text: 'VojtaV12' },
            plainMessage: 'hi',
            message: { text: '[OP] VojtaV12', color: 'gray' }
        });

        assert.strictEqual(plain.ansi, '\x1b[38;2;170;170;170m[OP] VojtaV12\x1b[0m hi');

        // Any colour the server picks survives, including a hex one it invented.
        const hexed = chatEventFromPacket('player_chat', {
            senderName: { text: 'VojtaV12' },
            networkName: { text: '[VIP] VojtaV12', color: '#55aaff' },
            plainMessage: 'yo'
        });
        assert.match(hexed.ansi, /\x1b\[38;2;85;170;255m\[VIP\] VojtaV12/);
    });

    await check('discord /auth never escalates', () => {
        const { DiscordBridge } = require('../src/discord');

        const grants = [];
        const registry = {
            permissions: {
                grant: (name, level, by) => {
                    grants.push({ name, level, by });
                    return level;
                },
                levelFor: ({ name }) => (String(name).toLowerCase() === 'adminperson' ? LEVEL.ADMIN : LEVEL.PUBLIC)
            }
        };
        const bridge = new DiscordBridge({
            config: { discord: { trustedId: 'T', adminId: 'A', ownerId: 'O' } },
            manager: null,
            logger,
            registry
        });
        const member = roles => ({
            roles: { cache: new Map(roles.map(role => [role, {}])) },
            user: { id: 'U' }
        });

        // Nobody without a staff role can hand out ranks.
        assert.strictEqual(bridge.grantRank(member([]), 'Alex', 'trusted').ok, false);

        // A Trusted member cannot grant admin, but can grant trusted.
        assert.strictEqual(bridge.grantRank(member(['T']), 'Alex', 'admin').ok, false);
        assert.strictEqual(bridge.grantRank(member(['T']), 'Alex', 'trusted').ok, true);

        // Nor can they strip someone who outranks them.
        assert.strictEqual(bridge.grantRank(member(['T']), 'AdminPerson', 'public').ok, false);

        // Admin cannot create an owner; owner can.
        assert.strictEqual(bridge.grantRank(member(['A']), 'Alex', 'owner').ok, false);
        assert.strictEqual(bridge.grantRank(member(['O']), 'Alex', 'owner').ok, true);

        // Names are validated before anything is stored.
        assert.strictEqual(bridge.grantRank(member(['O']), 'not a name!', 'trusted').ok, false);

        assert.deepStrictEqual(grants.map(grant => [grant.name, grant.level, grant.by]), [
            ['Alex', LEVEL.TRUSTED, 'discord:U'],
            ['Alex', LEVEL.OWNER, 'discord:U']
        ]);
    });

    await check('discord links and attachments open in game', () => {
        const { describeMessage, discordComponent } = require('../src/discord');

        const parts = describeMessage({
            content: 'look at https://example.com/a now',
            attachments: new Map([['1', { url: 'https://cdn.example.com/x.png', name: 'x.png' }]]),
            stickers: new Map(),
            embeds: []
        });

        const link = parts.find(part => part.click?.action === 'open_url' && part.text === 'https://example.com/a');
        assert.ok(link, 'a pasted link is clickable');
        assert.strictEqual(link.click.value, 'https://example.com/a');

        const attachment = parts.find(part => part.text === ' [attachment]');
        assert.ok(attachment, 'an attachment is a labelled button');
        assert.strictEqual(attachment.click.value, 'https://cdn.example.com/x.png');
        assert.strictEqual(attachment.click.action, 'open_url');

        const text = parts.map(part => part.text).join('');
        assert.ok(text.includes('look at'), text);
        assert.ok(text.includes('now'), text);

        // Both the link and the attachment stay clickable in the final tellraw.
        const component = discordComponent({ author: 'Alex', message: parts });
        assert.strictEqual(component.filter(part => part.click?.action === 'open_url').length, 2);
        assert.strictEqual(component.map(part => part.text).join(''),
            '[Discord] Alex: look at https://example.com/a now [attachment]');
    });

    await check('rtp teleports to a random spot through the core', async () => {
        const output = await run('<Unranked> v:rtp');
        assert.strictEqual(typeof output, 'string');

        assert.match(output, /^Teleporting Unranked to \d+ 100 \d+$/);
        assert.strictEqual(sent.length, 2, 'the reply comes before the teleport');
        assert.match(sent[1], /^\/?tp Unranked \d+ 100 \d+$/);
    });

    await check('kick repeats the title and subtitle ten times a second until the player is gone', async () => {
        const kick = require('../src/commands/kick');
        const { TITLE_INTERVAL_MS, TITLE_DEFAULT, targetedTitle } = require('../src/crash');
        assert.strictEqual(TITLE_INTERVAL_MS, 100, 'ten times a second');
        assert.strictEqual(TITLE_DEFAULT, 900, 'nine hundred selectors by default');

        const sent = [];
        const bot = {
            server: { username: 'vbot' },
            online: new Map([['steve', { name: 'Steve' }]]),
            core: {}
        };
        const ctx = {
            args: ['Steve'],
            prefix: 'v:',
            bot,
            run: command => (sent.push(command), true),
            reply: text => sent.push(`[reply] ${text}`)
        };

        await kick.execute(ctx);
        const payload = targetedTitle('Steve');
        assert.deepStrictEqual(sent.slice(0, 2), payload, 'the title and subtitle go out at once');
        assert.ok(payload[0].startsWith('title Steve title '), 'a title, aimed at that player alone');
        assert.ok(payload[1].startsWith('title Steve subtitle '), 'and a subtitle with it');
        for (const command of payload) {
            assert.strictEqual(
                command.split('{"selector":"@e[limit=100]"}').length - 1,
                TITLE_DEFAULT,
                'nine hundred selectors in each component');
            assert.ok(command.length <= 32000, 'and each still fits one core command');
        }
        assert.strictEqual(sent.length, 3, 'and the reply follows them');
        assert.ok(bot.kickLoops instanceof Map, 'the repeat is tracked on the bot');
        assert.strictEqual(bot.kickLoops.size, 1);

        // A second kick for the same name replaces the timer rather than adding
        // one, so the payload still goes out once per interval. A trailing number
        // is the selector count and the name in front of it is the target.
        await kick.execute({ ...ctx, args: ['Steve', '1200'] });
        assert.strictEqual(bot.kickLoops.size, 1, 'one timer per name');
        const bigger = targetedTitle('Steve', 1200);
        assert.strictEqual(
            sent.filter(command => bigger.includes(command)).length,
            bigger.length,
            'a count argument changes the selector stack');
        assert.ok(
            bigger[0].split('{"selector":"@e[limit=100]"}').length - 1 > TITLE_DEFAULT,
            'and it asks for more selectors');

        // Back to the default payload for the rest of the checks.
        await kick.execute(ctx);

        const sentBefore = sent.filter(command => payload.includes(command)).length;
        await new Promise(resolve => setTimeout(resolve, TITLE_INTERVAL_MS + 80));
        const sentDuring = sent.filter(command => payload.includes(command)).length;
        assert.ok(sentDuring > sentBefore + 1, 'it repeats both while they are online');

        bot.online.delete('steve');
        await new Promise(resolve => setTimeout(resolve, TITLE_INTERVAL_MS + 80));
        const sentAfter = sent.filter(command => payload.includes(command)).length;
        assert.strictEqual(sentAfter, sentDuring, 'nothing is sent once they left');
        assert.strictEqual(bot.kickLoops.size, 0, 'the loop clears itself');
    });

    await check('kick accepts @a, @p and @r selectors', async () => {
        const kick = require('../src/commands/kick');
        const { targetedTitle } = require('../src/crash');

        const sent = [];
        const bot = {
            server: { username: 'vbot' },
            online: new Map([
                ['steve', { name: 'Steve' }],
                ['alex', { name: 'Alex' }]
            ]),
            core: {}
        };
        const run = args => kick.execute({
            args,
            prefix: 'v:',
            bot,
            run: command => (sent.push(command), true),
            reply: text => (sent.push(`[reply] ${text}`), text)
        });
        const stopLoops = () => {
            for (const timer of bot.kickLoops?.values() ?? []) clearInterval(timer);
            bot.kickLoops?.clear();
        };

        await run(['@a']);
        assert.deepStrictEqual(sent.slice(0, 2), targetedTitle('@a'), 'the whole list is titled by selector');
        assert.strictEqual(bot.kickLoops.size, 1, 'one loop for @a, not one per player');
        assert.match(sent[2], /@a/);

        stopLoops();
        sent.length = 0;

        await run(['@p']);
        assert.deepStrictEqual(sent.slice(0, 2), targetedTitle('@p'), '@p is left to the server');
        assert.strictEqual(sent.length, 3);
        assert.match(sent[2], /@p \(Steve\)/);

        stopLoops();
        sent.length = 0;

        await run(['@r']);
        assert.deepStrictEqual(sent.slice(0, 2), targetedTitle('@r'), '@r is left to the server');
        assert.match(sent[2], /@r \((Steve|Alex)\)/);

        stopLoops();
        sent.length = 0;

        // Selector arguments belong to the server, so they go through as written.
        await run(['@a[distance=..5]']);
        assert.ok(sent[0].startsWith('title @a[distance=..5] title '), 'arguments go through');
        stopLoops();
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
