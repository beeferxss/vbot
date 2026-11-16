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
        assert.strictEqual(config.core.area.size, 9, 'the core is 9x9x9');
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
        assert.deepStrictEqual(shipped.owner, ['VojtaV12']);
        assert.deepStrictEqual(shipped.admin, []);
        assert.deepStrictEqual(shipped.trusted, []);
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

    await check('the chat prefix is styled and per server wins', () => {
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
        tagged.chat = message => (sent.push(message), true);
        tagged.applyPrefixTag();
        return new Promise(resolve => setTimeout(() => {
            assert.deepStrictEqual(sent, ['/prefix &a[prefix: v\\]']);
            resolve();
        }, 1400));
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
        // The block is repeating, and the packet has to say so.
        assert.strictEqual(writes[0].payload.mode, 1, 'a repeating block is written as repeating');
        assert.strictEqual(writes[0].payload.flags, 0b101, 'always active, tracking output');
        assert.strictEqual(writes[1].payload.command, 'gamemode creative');

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
        modern.refill('test');
        assert.strictEqual(
            named[0],
            '/fill 0 64 0 8 72 8 minecraft:repeating_command_block{CustomName:{text:\'vbot\',color:\'green\'}} replace'
        );
        assert.match(modern.status(), /name \{"text"/);

        const legacy = new Core({ bot: fake('1.20.4'), config: nameConfig, logger });
        legacy.reset();
        legacy.refill('test');
        assert.strictEqual(
            named[1],
            '/fill 0 64 0 8 72 8 minecraft:repeating_command_block{CustomName:\'{"text":"vbot","color":"green"}\'} replace'
        );

        // Without a name the fill stays plain.
        const plainCore = new Core({
            bot: fake('1.21.5'),
            config: { enabled: true, area: { size: 9, y: 64 }, refill: { enabled: true, item: false } },
            logger
        });
        plainCore.reset();
        plainCore.refill('test');
        assert.strictEqual(
            named[2],
            '/fill 0 64 0 8 72 8 minecraft:repeating_command_block replace'
        );

        modern.destroy();
        legacy.destroy();
        plainCore.destroy();
    });

    await check('a command block item is placed, filled and broken again', async () => {
        const { FillItem, plainItem, usesComponents } = require('../src/fillitem');
        const data = { itemsByName: { repeating_command_block: { id: 419 } } };

        // A plain item: no components, so there is nothing to translate.
        assert.strictEqual(usesComponents('1.21.4'), true);
        assert.strictEqual(usesComponents('1.20.4'), false);
        assert.deepStrictEqual(plainItem('1.21.4', 419), {
            itemCount: 1,
            itemId: 419,
            addedComponentCount: 0,
            removedComponentCount: 0,
            components: [],
            removeComponents: []
        });
        assert.deepStrictEqual(plainItem('1.20.4', 394), { present: true, itemCount: 1, itemId: 394 });

        const writes = [];
        const itemBot = {
            client: { version: '1.21.4' },
            position: { x: 10.7, y: 64, z: -3.2 },
            write: (name, payload) => (writes.push({ name, payload }), true)
        };
        const fillItem = new FillItem({ bot: itemBot, logger, data, config: { breakDelayMs: 40 } });

        assert.strictEqual(fillItem.usable, true);
        assert.strictEqual(
            fillItem.run('fill 1 2 3 4 5 6 minecraft:command_block replace', 2),
            true
        );
        assert.strictEqual(fillItem.run('anything', 1), false, 'one placement at a time');

        assert.deepStrictEqual(writes.map(write => write.name), [
            'set_creative_slot',
            'held_item_slot',
            'block_place',
            'update_command_block'
        ]);
        assert.strictEqual(writes[0].payload.slot, 36);
        assert.strictEqual(writes[0].payload.item.itemId, 419);
        assert.strictEqual(writes[0].payload.item.components.length, 0, 'the item carries no data');
        assert.strictEqual(writes[1].payload.slotId, 0);
        assert.deepStrictEqual(writes[2].payload.location, { x: 10, y: 63, z: -4 }, 'the block the bot stands on');
        assert.strictEqual(writes[2].payload.direction, 1, 'placed on its top face');
        // The command goes into the placed block, which repeats, so it runs.
        assert.deepStrictEqual(writes[3].payload.location, { x: 10, y: 64, z: -4 });
        assert.strictEqual(writes[3].payload.mode, 2, 'impulse');
        assert.match(writes[3].payload.command, /^fill 1 2 3 4 5 6 /);

        await new Promise(resolve => setTimeout(resolve, 90));

        // Every protocol the bot can speak encodes these packets, or nothing
        // leaves the client at all.
        const mc = require('minecraft-protocol');
        for (const version of ['1.20.1', '1.21.4', '1.21.5', '1.21.9', '26.1']) {
            const d = require('minecraft-data')(version);
            const item = plainItem(version, d.itemsByName.repeating_command_block.id);
            const serializer = mc.createSerializer({ state: 'play', isServer: false, version });
            assert.ok(
                serializer.createPacketBuffer({ name: 'set_creative_slot', params: { slot: 36, item } }).length > 0,
                `${version} should encode the item`
            );
            assert.ok(serializer.createPacketBuffer({
                name: 'block_place',
                params: {
                    hand: 0,
                    location: { x: 1, y: 2, z: 3 },
                    direction: 1,
                    cursorX: 0.5,
                    cursorY: 1,
                    cursorZ: 0.5,
                    insideBlock: false,
                    worldBorderHit: false,
                    sequence: 1
                }
            }).length > 0, `${version} should encode the placement`);
            assert.ok(serializer.createPacketBuffer({
                name: 'update_command_block',
                params: { location: { x: 1, y: 2, z: 3 }, command: 'say hi', mode: 1, flags: 0b101 }
            }).length > 0, `${version} should encode the command write`);
        }

        const dig = writes.find(write => write.name === 'block_dig');
        assert.ok(dig, 'the placed block has to be broken again');
        assert.deepStrictEqual(dig.payload.location, { x: 10, y: 64, z: -4 }, 'only that block');
        assert.strictEqual(dig.payload.status, 0);
        assert.deepStrictEqual(writes.map(write => write.name).slice(-2), ['block_dig', 'set_creative_slot']);
        assert.strictEqual(writes[writes.length - 1].payload.item.itemCount, 0, 'the slot is cleared');

        fillItem.destroy();
    });

    await check('item numbers come from the server registries', async () => {
        const { FillItem } = require('../src/fillitem');

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

        // The server's number is what gets sent, not the bundled one.
        const writes = [];
        const bot = {
            client: { version: '1.21.4' },
            position: { x: 0, y: 64, z: 0 },
            write: (name, payload) => (writes.push({ name, payload }), true),
            registries: { item: new Map([['repeating_command_block', 281]]), components: null }
        };
        const item = new FillItem({
            bot,
            logger,
            data: { itemsByName: { repeating_command_block: { id: 419 } } }
        });
        assert.strictEqual(item.itemId(), 281);
        assert.strictEqual(item.usable, true);
        item.give();
        assert.strictEqual(writes[0].payload.item.itemId, 281);
        item.destroy();
    });

    await check('refills place a command block item before anything else', async () => {
        const used = [];
        const core = new Core({
            bot: { position: { x: 0, y: 70, z: 0 }, chat: () => true, write: () => true, log: logger },
            config: { enabled: true, area: { size: 9, y: 64 }, refill: { enabled: true } },
            logger
        });
        core.reset();
        // Only a core that has worked before rebuilds through an item: the first
        // build has no fallback if the placement is refused, so it goes as chat.
        core.everReady = true;
        core.fillItem = { usable: true, run: command => (used.push(command), true), destroy: () => {} };

        assert.strictEqual(core.refill('damaged', { force: true }), true);
        assert.strictEqual(used.length, 1);
        assert.match(used[0], /^fill 0 64 0 8 72 8 /, 'the item carries the fill');

        // No chat fill went out: the item was used instead.
        core.refill('damaged', { force: true });
        assert.strictEqual(used.length, 2);
        assert.strictEqual(core.itemFills, 2);
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

        core.onReady();
        assert.match(sent[0], /^\/fill 0 64 0 1 65 1 /);
        await new Promise(resolve => setTimeout(resolve, 450));
        assert.strictEqual(core.ready, true);

        // Nothing standing: the watchdog has to fall back to chat, repeatedly.
        for (const key of core.blocks.keys()) core.blocks.set(key, false);
        sent.length = 0;
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.ok(sent.length >= 1, 'the watchdog should rebuild the core through chat');
        assert.match(sent[0], /^\/fill 0 64 0 1 65 1 /);

        core.destroy();
        const after = sent.length;
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.strictEqual(sent.length, after, 'destroy stops the watchdog');
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
        core.reset();
        core.refill('startup');
        await new Promise(resolve => setTimeout(resolve, 300));
        sent.length = 0;
        core.refilling = false;
        core.graceUntil = 0;
        core.lastRefillAt = 0;
        core.ready = true;
        core.markAllAlive();

        core.onBlockChange({ location: { x: 1, y: 64, z: 1 } });
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.ok(sent.length >= 1, 'damage should trigger a refill');
        assert.match(sent[sent.length - 1], /^\/fill 0 64 0 3 67 3 /);
        core.destroy();
    });

    await check('an automatic refill reuses a surviving block, but an explicit one chats', async () => {
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
            config: { enabled: true, area: { size: 2, y: 64 }, refill: { enabled: true } },
            logger
        });
        core.reset();

        core.refill('startup');
        assert.match(sent[0], /^\/fill 0 64 0 1 65 1 /);
        await new Promise(resolve => setTimeout(resolve, 450));
        assert.strictEqual(core.ready, true);
        assert.strictEqual(core.blocks.size, 8, 'every cell is recorded once the fill lands');

        // One survivor left: an automatic refill writes into it, quietly.
        for (const key of core.blocks.keys()) {
            if (key !== '1:65:1') core.blocks.set(key, false);
        }
        sent.length = 0;
        writes.length = 0;
        core.lastRefillAt = 0; // pretend the last refill is old enough
        core.refill('damaged');
        assert.deepStrictEqual(sent, [], 'a surviving block carries the fill');
        assert.strictEqual(writes.length, 1);
        assert.deepStrictEqual(writes[0].payload.location, { x: 1, y: 65, z: 1 });
        assert.match(writes[0].payload.command, /^fill 0 64 0 1 65 1 /);

        // v\core refill asks for chat even though a block is available.
        await new Promise(resolve => setTimeout(resolve, 450));
        sent.length = 0;
        writes.length = 0;
        core.lastRefillAt = 0;
        core.refill('command', { viaChat: true });
        assert.strictEqual(writes.length, 0, 'an explicit refill never writes into a block');
        assert.match(sent[0], /^\/fill 0 64 0 1 65 1 /);
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

    await check('commands load with unique names and aliases', () => {
        assert.ok(registry.commands.size >= 5, `expected commands, got ${registry.commands.size}`);
        assert.ok(registry.find('whois'), 'identity alias missing');
        assert.strictEqual(registry.find('whoami').name, 'whoami');
    });

    await check('the degree prefix is a real prefix', () => {
        const exampleConfig = loadConfig(examplePath);
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
        assert.strictEqual(degreeRegistry.matchPrefix('v\\help'), 'v\\');
        assert.strictEqual(degreeRegistry.matchPrefix('!help'), null);
    });

    await check('help lists every rank and marks the ones you cannot use', async () => {
        sent.length = 0;
        await registry.dispatch({ bot: fakeBot, parsed: parseChatLine('<Unranked> v:help') });
        const output = decodeReply(sent[0]);
        assert.match(output, /^Commands \(\d+\)/);
        assert.match(output, /public: .*help/);
        assert.match(output, /trusted: .*identity/);
        assert.match(output, /public: alts /);
        assert.match(output, /public: .*core/, 'the core command is public');
        assert.match(output, /admin: filter refill whitelist/);

        const listing = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);
        const identity = listing.find(part => part.text === 'identity');
        assert.ok(identity, 'trusted commands are still listed to a public player');
        assert.strictEqual(identity.color, 'dark_gray');
        assert.ok(!identity.clickEvent, 'a command you cannot use must not be clickable');
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

        // A single command explains itself, with its usage copied on click.
        sent.length = 0;
        await registry.dispatch({ bot: fakeBot, parsed: parseChatLine('<Unranked> v:help ping') });
        const detail = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);
        assert.strictEqual(detail[0].clickEvent.action, 'copy_to_clipboard');
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

    await check('replies are private tellraw, with a chat fallback', async () => {
        sent.length = 0;
        await registry.dispatch({ bot: fakeBot, parsed: parseChatLine('<Unranked> v:help') });
        assert.match(sent[0], /^\/tellraw Unranked [[{]/);
        assert.match(decodeReply(sent[0]), /Commands \(\d+\)/);

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

        // No fill has landed yet, so there is no block to reuse: chat it is, and
        // the fill must not be routed back into the core.
        packets.length = 0;
        core.refill('damaged');
        assert.deepStrictEqual(spoken.slice(1), ['/fill 0 64 0 1 65 1 minecraft:repeating_command_block replace']);
        assert.strictEqual(packets.length, 0, 'a refill is never routed back through the core');
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
            core: { origin: { x: null }, statusParts: () => [{ text: 'core ready', color: 'green' }] }
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
        assert.match(decodeReply(sent[0]), /core ready/);
        assert.ok(!/token/.test(decodeReply(sent[0])), 'an owner click is not asked for a token');

        clicks.destroy();
    });

    await check('core status colours its name and offers a refill button', async () => {
        const { ClickTokens } = require('../src/clicktokens');
        const clicks = new ClickTokens({ logger });
        const named = [];
        const core = new Core({
            bot: {
                client: { version: '1.20.4' },
                position: { x: 0, y: 70, z: 0 },
                chat: command => named.push(command),
                write: () => true,
                log: logger
            },
            config: {
                enabled: true,
                name: '{"text":"vbot","color":"green"}',
                area: { size: 2, y: 64 },
                refill: { enabled: true }
            },
            logger
        });
        core.reset({ x: 0, y: 70, z: 0 });

        const statusBot = { ...fakeBot, core, clickTokens: clicks };
        sent.length = 0;
        await registry.dispatch({ bot: statusBot, parsed: parseChatLine('<VojtaV12> v:core status') });

        const parts = JSON.parse(/^\/tellraw \S+ (.*)$/s.exec(sent[0])[1]);
        const name = parts.find(part => part.text === 'vbot');
        assert.ok(name, 'the configured name is shown');
        assert.strictEqual(name.color, 'green', 'the name keeps its colour');

        const button = parts.find(part => part.clickEvent?.action === 'run_command');
        assert.ok(button, 'the refill button runs a command');
        assert.match(button.clickEvent.value, /^\/random value \d+\.\.\d+$/);

        // Clicking it as an owner refills the core for real.
        named.length = 0;
        assert.strictEqual(clicks.handle(`VojtaV12 issued server command: ${button.clickEvent.value}`), true);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(named.some(command => command.startsWith('/fill 0 64 0 1 65 1 ')), 'the click refilled the core');

        core.destroy();
        clicks.destroy();
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
        // One page of eight: a name and a UUID each copy the UUID.
        assert.strictEqual(first.filter(part => part.clickEvent?.action === 'copy_to_clipboard').length, 16);
        assert.strictEqual(first.filter(part => part.text === ' - ').length, 8);

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

    await check('core skips commands while its area is not loaded', () => {
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

        // The bot was teleported far away: command blocks in the core chunk do
        // not tick, so the write is refused instead of silently lost.
        core.bot.position = { x: 5000, y: 70, z: 5000 };
        assert.strictEqual(core.run('say hi'), null);
        assert.strictEqual(writes.length, 0);

        core.bot.position = { x: 1000, y: 70, z: 1000 };
        assert.deepStrictEqual(core.run('say hi'), { x: 1000, y: 64, z: 1000 });
        assert.strictEqual(writes.length, 1);
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
