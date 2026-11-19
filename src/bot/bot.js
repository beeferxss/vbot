'use strict';

const EventEmitter = require('node:events');
const mc = require('minecraft-protocol');
const { chatTextFromPacket, chatEventFromPacket, languageFor, parseChatLine } = require('../minecraft/chat');
const { normalizeUuid, offlineUuid } = require('../minecraft/uuid');
const { playerInfoEntries } = require('../minecraft/players');
const { resolveServerAddress } = require('../minecraft/address');
const { Core } = require('../core');
const { ClickTokens } = require('../clicktokens');
const { SelfCare } = require('../selfcare');
const { BotCSpy } = require('../botcspy');
const { Warp } = require('../warp');
const { FilterGuard } = require('../filterguard');
const { IpLookup } = require('../iplookup');
const path = require('node:path');
const { Filter } = require('../filter');
const { Whitelist } = require('../whitelist');
const { Cloops } = require('../cloops');
const { attachTabComplete } = require('../tabcomplete');

const CHAT_PACKETS = ['chat', 'player_chat', 'profileless_chat', 'system_chat', 'disguised_chat'];

// A vanished player is dropped from the tab list but not from a selector, so the
// bot asks @a who is really online and reads the answer back out of chat.
const PLAYER_LIST_MARKER = '[PLAYER_LIST]';

class Bot extends EventEmitter {
    constructor({ server, config, store, permissions, registry, logger }) {
        super();
        this.id = server.id;
        this.server = server;
        this.config = config;
        this.store = store;
        this.permissions = permissions;
        this.registry = registry;
        this.log = logger.child(server.id);
        this.core = new Core({ bot: this, config: config.core, logger: this.log });
        this.clickTokens = new ClickTokens({
            logger: this.log,
            uuidFor: name => this.uuidFor(name),
            onCommand: (suggestion, clicker) => this.runSuggestion(suggestion, clicker)
        });
        this.selfCare = new SelfCare({
            bot: this,
            config: config.selfCare || {},
            logger: this.log
        });
        // Reads the commands other bots run, out of the command blocks that hold
        // them: `botcspy` drives it.
        this.cspy = new BotCSpy({ bot: this, logger: this.log });
        // A server that deops the bot over and over is filtering it; a different
        // address is the way out, and Cloudflare WARP is what changes it.
        this.warp = new Warp({ config: config.warp || {}, logger: this.log });
        this.filterGuard = new FilterGuard({
            bot: this,
            config: config.filterGuard || {},
            warp: this.warp,
            logger: this.log
        });
        this.ipLookup = new IpLookup({
            bot: this,
            store,
            config: config.alts || {},
            logger: this.log
        });

        const dataDir = path.join(require('../config').ROOT || process.cwd(), 'data');
        this.filter = new Filter({
            bot: this,
            storePath: path.join(dataDir, 'filter.json'),
            logger: this.log
        });
        this.whitelist = new Whitelist({
            bot: this,
            storePath: path.join(dataDir, 'whitelist.json'),
            logger: this.log
        });
        this.cloops = new Cloops({
            bot: this,
            storePath: path.join(dataDir, 'cloops.json'),
            config: config.cloops || {},
            logger: this.log
        });
        attachTabComplete(this);

        this.client = null;
        this.position = null;
        this.connectedAt = null;
        // Filled in from the server's own registries at login.
        this.registries = { item: null, components: null };
        this.state = 'idle';
        this.attempts = 0;
        this.reconnectTimer = null;
        // Set while the address is being resolved and the client built, so a
        // second start() cannot open a second connection over the same server.
        this.connecting = false;
        this.loginTimer = null;
        this.destroyed = false;
        this.disconnectReason = null;
        this.known = new Map();
        // Who is online, as lower-case name -> { name, uuid, vanished }. Filled
        // from the tab list and from the selector scan, so vanished players are
        // in here too.
        this.online = new Map();
        // Who the tab list itself lists, to tell a vanished player from a listed one.
        this.listed = new Set();
        this.scanTimer = null;
        // Set once a signed player chat packet arrives: until then the server may
        // simply not support chat signing, so unsigned chat is all there is.
        this.signedChatSeen = false;
        this.nickSent = false;
        this.prefixSent = false;
        // The server keeps the player "loading terrain" until the client says the
        // world is done; block placement is ignored until then.
        this.loadedSent = false;
        this.supportsPlayerLoaded = false;
    }

    get connection() {
        return this.config.minecraft.connection;
    }

    start() {
        if (this.destroyed || this.client || this.connecting || this.reconnectTimer) return false;
        this.connect();
        return true;
    }

    connect() {
        this.reconnectTimer = null;
        if (this.destroyed || this.client || this.connecting) return;

        this.connecting = true;
        this.state = 'connecting';
        // Looking the address up is async, so the client is built off the caller's
        // stack; a failure is a lost attempt, not a crash.
        this.open()
            .catch(error => {
                this.log.error(`connect failed: ${error.message}`);
                this.state = 'offline';
                this.scheduleReconnect();
            })
            .finally(() => { this.connecting = false; });
    }

    async open() {
        const { server } = this;

        // The address a client dials is not always the name it types: play.norat.pw
        // and alt.norat.pw have no A record at all, only a _minecraft._tcp SRV
        // record. minecraft-protocol follows that on its own default path, but a
        // custom connect (and anything that hands the name to the WARP tunnel)
        // skips it, and then the lookup happens against a name with no address.
        const target = await resolveServerAddress({ host: server.host, port: server.port });
        if (this.destroyed) return;
        if (target.host !== server.host || target.port !== server.port) {
            this.log.info(`${server.host} answers on ${target.host}:${target.port}`);
        }

        const options = {
            host: target.host,
            port: target.port,
            username: server.username,
            auth: server.auth,
            // Proxies route on the hostname in the handshake, and a vanilla client
            // always sends the one the player typed, never the SRV target.
            fakeHost: server.host
        };
        const version = server.version || this.config.minecraft.version;
        if (version) options.version = version;

        // A server that has filtered the bot once sees a different address from
        // then on: every connection goes through the WARP proxy, which is what
        // the filter guard turns over.
        if (this.warp?.enabled) {
            options.connect = client => this.warp.attach(client, target);
            this.log.info(
                `connecting to ${target.host}:${target.port} as ${server.username} ` +
                `through the WARP proxy at ${this.warp.proxyUrl}`
            );
        } else {
            this.log.info(`connecting to ${target.host}:${target.port} as ${server.username}`);
        }

        let client;
        try {
            client = mc.createClient(options);
        } catch (error) {
            this.log.error(`createClient failed: ${error.message}`);
            this.scheduleReconnect();
            return;
        }

        this.client = client;
        this.bind(client);
        this.core?.bindClient(client);
        this.cspy?.bind(client);
        this.armLoginWatchdog(client);
    }

    // A server that takes the socket and then says nothing leaves the bot sitting
    // in 'connecting' with nothing to show for it. Fail the attempt instead, so the
    // reason is in the log and the reconnect happens on its own.
    armLoginWatchdog(client) {
        this.clearLoginWatchdog();
        const timeoutMs = positive(this.connection.loginTimeoutMs, 30000);
        this.loginTimer = setTimeout(() => {
            this.loginTimer = null;
            if (this.client !== client || this.state === 'ready' || this.destroyed) return;
            this.disconnectReason = `login timed out after ${timeoutMs}ms`;
            this.log.error(`${this.disconnectReason}; dropping the connection`);
            try { client.end('login timeout'); } catch { /* already gone */ }
        }, timeoutMs);
        this.loginTimer.unref?.();
    }

    clearLoginWatchdog() {
        if (!this.loginTimer) return;
        clearTimeout(this.loginTimer);
        this.loginTimer = null;
    }

    bind(client) {
        // Errors can still arrive after 'end' (minecraft-protocol re-emits the
        // auto-version ping failure), so listeners are never stripped: a stale
        // client is recognised by identity instead of by removing handlers.
        const isCurrent = () => this.client === client;

        client.on('login', packet => {
            this.clearLoginWatchdog();
            this.attempts = 0;
            this.state = 'ready';
            this.connectedAt = Date.now();
            this.disconnectReason = null;
            this.log.info(
                `connected as ${this.server.username} ` +
                `(protocol ${client.version ?? 'unknown'}, gamemode ${packet.gameMode ?? '?'})`
            );
            this.selfCare?.onLoginPacket(packet);
            this.filterGuard?.onReady();
            this.loadedSent = false;
            this.supportsPlayerLoaded = this.supportsPacket('player_loaded');
            this.emit('ready');
            this.applyNick();
            this.applyPrefixTag();
            this.startPlayerScan();
            // Give the position packet a moment to arrive before placing anything.
            setTimeout(() => this.core?.onReady(), 1500).unref?.();
            this.filter?.start();
            this.whitelist?.start();
            this.cloops?.start();
        });

        for (const event of ['player_info', 'player_info_update']) {
            client.on(event, packet => this.handlePlayerInfo(packet));
        }
        client.on('player_remove', packet => this.handlePlayerRemove(packet));

        for (const event of ['position', 'position_look']) {
            client.on(event, packet => {
                if (Number.isFinite(packet?.x) && Number.isFinite(packet?.y) && Number.isFinite(packet?.z)) {
                    this.position = { x: packet.x, y: packet.y, z: packet.z };
                    // The core needs the position and gets one attempt of its own:
                    // a server that sends it late (a queue, a proxy, a slow
                    // world) would otherwise leave the bot without a core, which
                    // means no fill and no commands that need one.
                    if (this.core && this.state === 'ready' && !this.core.started && !this.core.joining) {
                        this.core.onReady();
                    }
                    // Where the bot last stood in the overworld: the way back if
                    // something teleports it into the end.
                    this.selfCare?.notePosition(this.position);
                }
                // A teleport is only accepted once it is confirmed, and the world
                // only counts as loaded once the client says so. Until both have
                // happened the server ignores block placement.
                if (packet?.teleportId !== undefined && packet?.teleportId !== null) {
                    this.write('teleport_confirm', { teleportId: packet.teleportId });
                }
                this.sendPlayerLoaded();
            });
        }

        client.on('registry_data', packet => this.noteRegistry(packet));
        client.on('block_change', packet => this.core?.onBlockChange(packet));
        client.on('entity_status', packet => this.selfCare?.onEntityStatus(packet));
        client.on('entity_status', packet => this.filterGuard?.onEntityStatus(packet));
        client.on('game_state_change', packet => this.selfCare?.onGameStateChange(packet));
        client.on('respawn', packet => this.selfCare?.onRespawn(packet));

        for (const event of CHAT_PACKETS) {
            client.on(event, packet => this.handleChatEvent(event, packet));
        }

        client.on('disconnect', packet => {
            const reason = chatTextFromPacket(packet) || packet?.reason || 'disconnected';
            this.disconnectReason = String(reason).trim();
            this.log.warn(`kick: ${this.disconnectReason}`);
        });

        client.on('error', error => {
            this.disconnectReason = error.message || 'error';
            if (!isCurrent()) return this.log.debug(`late socket error: ${this.disconnectReason}`);
            this.log.error(`socket error: ${this.disconnectReason}`);
        });

        client.on('end', () => {
            if (!isCurrent()) return;
            this.clearLoginWatchdog();
            this.client = null;
            this.state = 'offline';
            this.connectedAt = null;
            this.log.warn(`disconnected (${this.disconnectReason || 'socket closed'})`);
            this.emit('disconnect', this.disconnectReason);
            this.nickSent = false;
            this.prefixSent = false;
            this.loadedSent = false;
            this.registries = { item: null, components: null };
            this.online.clear();
            this.listed.clear();
            if (this.scanTimer) clearInterval(this.scanTimer);
            this.scanTimer = null;
            this.filter?.destroy();
            this.whitelist?.destroy();
            this.cloops?.destroy();
            this.core?.destroy();
            this.clickTokens?.clear();
            if (this.connection.autoReconnect && !this.destroyed) this.scheduleReconnect();
        });
    }

    handleChatEvent(event, packet) {
        // Translate keys only become sentences with the version's en_us table.
        const language = languageFor(this.client?.version || this.config.minecraft?.version || null);
        const chat = chatEventFromPacket(event, packet, language);
        if (!chat || !chat.line) return;

        // A signed chat packet is the only place a name and uuid are worth
        // trusting, and it also keeps the identity cache warm between logins.
        if (chat.verified) this.signedChatSeen = true;

        if (chat.verified && chat.username && chat.uuid) {
            this.known.set(chat.username.toLowerCase(), chat.uuid);
            this.store.linkPlayer(chat.username, chat.uuid);
        }

        // The console shows the line the way the server drew it.
        if (this.config.logging?.chat) {
            this.log.info(`${chat.verified ? '' : '(system) '}${chat.ansi || chat.line}`);
        }

        // A button was clicked: the matching /random line names the clicker and
        // the action, and never needs to be dispatched as a command.
        if (this.clickTokens?.handle(chat.line)) return;

        // Fill results are the only confirmation that a refill actually ran,
        // and command-block writes are confirmed too. Both are consumed here so
        // the core's own bookkeeping never reaches commands or the chat relay.
        if (this.core?.noteMessage(chat.line)) return;

        // The selector scan reports back through chat.
        if (this.notePlayerList(chat.line)) return;

        const parsed = chat.verified && chat.username
            ? { username: chat.username, message: chat.message }
            : parseChatLine(chat.line);

        if (parsed) {
            const uuid = chat.uuid || (chat.verified ? null : null) || this.uuidFor(parsed.username);
            parsed.uuid = uuid;
            this.store.touchPlayer(parsed.username, uuid);
        }

        this.emit('chat', { line: chat.line, ansi: chat.ansi, parsed, verified: chat.verified });

        if (parsed) {
            this.registry
                .dispatch({ bot: this, parsed, line: chat.line, verified: chat.verified, real: chat.real })
                .catch(error => this.log.error(`command dispatch failed: ${error.stack || error.message}`));
        }
    }

    // The tab list is also the only source of who is online, so it is kept
    // separate from the identity cache: a player who leaves stays known.
    handlePlayerRemove(packet) {
        const gone = new Set();
        for (const list of [packet?.players, packet?.entries, packet?.data]) {
            if (!Array.isArray(list)) continue;
            for (const entry of list) {
                const uuid = normalizeUuid(entry?.uuid ?? entry);
                if (uuid) gone.add(uuid);
                const name = entry?.name;
                if (typeof name === 'string') gone.add(name.toLowerCase());
            }
        }
        if (!gone.size) return;

        for (const [key, player] of this.online) {
            if (!gone.has(key) && !gone.has(player.uuid)) continue;
            this.online.delete(key);
            this.listed.delete(key);
        }
        for (const key of gone) this.listed.delete(key);
    }

    // Online-mode servers send real UUIDs in the player list; offline-mode
    // servers derive them from the name, so nothing needs to arrive at all.
    // The registries the server sends at login are the only authority on the
    // numbers packets use: the position of an entry in each list is its id, and
    // a proxy can hand out different numbers than any bundled data has.
    noteRegistry(packet) {
        const name = String(packet?.id || '').replace(/^minecraft:/, '');
        const entries = packet?.entries;
        if (!name || !Array.isArray(entries) || !entries.length) return false;
        if (name !== 'item' && name !== 'data_component_type') return false;

        const ids = new Map();
        entries.forEach((entry, index) => {
            const key = String(entry?.key || '').replace(/^minecraft:/, '');
            if (key) ids.set(key, index);
        });
        if (!ids.size) return false;

        if (name === 'item') {
            this.registries.item = ids;
            if (ids.has('command_block')) {
                this.log.info(`item ids: ${ids.size} entries, command_block is ${ids.get('command_block')}`);
            }
        } else {
            this.registries.components = ids;
            if (ids.has('block_entity_data')) {
                this.log.info(
                    `component ids: ${ids.size} entries, block_entity_data is ${ids.get('block_entity_data')}`
                );
            }
        }
        return true;
    }

    handlePlayerInfo(packet) {
        const entries = playerInfoEntries(packet);
        const actions = Array.isArray(packet?.actions) ? packet.actions.map(String) : [];

        // Older protocols put removal in player_info as action 4.
        if (Number(packet?.action) === 4 || actions.includes('remove_player')) {
            this.handlePlayerRemove(packet);
            return;
        }

        // 1.19.3+ can hide a player with update_listed and listed: false, and
        // that packet carries only a uuid, so the name is looked up below.
        for (const entry of packet?.entries || []) {
            if (!entry || entry.listed !== false) continue;
            const uuid = normalizeUuid(entry.uuid ?? entry.id);
            if (!uuid) continue;
            for (const [key, player] of this.online) {
                if (player.uuid !== uuid) continue;
                this.online.delete(key);
                this.listed.delete(key);
            }
        }

        for (const entry of entries) {
            const { name, listed } = entry;
            const uuid = entry.uuid || this.uuidFor(name);
            const key = name.toLowerCase();

            if (listed === false) {
                this.online.delete(key);
                this.listed.delete(key);
                continue;
            }

            // Every entry means this player is in the tab list. The identity
            // cache is separate: it outlives a player leaving, so it is only
            // rewritten when something actually changed.
            // Our own entry is where the gamemode comes from on modern servers.
            if (entry.gamemode !== undefined) {
                if (uuid && this.uuid && uuid === this.uuid) this.selfCare?.noteGamemode(entry.gamemode);
                else if (!uuid && name.toLowerCase() === String(this.server.username || '').toLowerCase()) {
                    this.selfCare?.noteGamemode(entry.gamemode);
                }
            }

            const isNew = !this.online.has(key);
            this.online.set(key, { name, uuid });
            this.listed.add(key);
            if (isNew) {
                this.ipLookup?.queue(name);
                // A rank redeemed with a token belongs to the session it was
                // redeemed in, so joining again starts at public instead of
                // carrying an old rank back in.
                if (this.permissions?.clearSessionRank?.(name)) {
                    this.log.debug(`cleared the session rank of ${name} after a rejoin`);
                }
            }

            if (this.known.get(key) !== uuid) {
                this.known.set(key, uuid);
                this.store.linkPlayer(name, uuid);
                this.log.debug(`identity ${name} -> ${uuid}`);
                this.emit('player', { name, uuid });
            }
        }

        this.log.debug(`player list: ${entries.length} entries, ${this.online.size} online`);
    }

    // Resolution order: seen in the player list, already stored, then the
    // offline-mode derivation. Online-mode servers get null until we are told.
    uuidFor(name) {
        const key = String(name || '').toLowerCase();
        if (!key) return null;

        const known = this.known.get(key);
        if (known) return known;

        const stored = this.store.getPlayer(name)?.uuid;
        if (stored) return normalizeUuid(stored);

        if (this.server.auth === 'offline') return offlineUuid(name);
        return null;
    }

    // Asks the server for every online player. A selector counts vanished
    // players, a tab list does not, and only the bot is told the answer.
    scanOnline() {
        if (this.state !== 'ready' || this.destroyed) return false;
        const target = this.server.username;
        if (!target) return false;

        const component = JSON.stringify({
            text: PLAYER_LIST_MARKER,
            extra: [{ selector: '@a' }]
        });
        // The slash matters: without it this is bot chatter, not a command. With
        // it the scan runs through a core block like any other command.
        return this.chat(`/tellraw ${target} ${component}`);
    }

    startPlayerScan() {
        if (this.scanTimer) return;
        const interval = positive(this.config.list?.scanMs, 20000);
        // The first scan waits for the world to load, like the reference does.
        setTimeout(() => this.scanOnline(), 3000).unref?.();
        this.scanTimer = setInterval(() => this.scanOnline(), interval);
        this.scanTimer.unref?.();
    }

    // "[PLAYER_LIST] Steve, Alex" -> both are online, and whoever the tab list
    // does not list is vanished.
    notePlayerList(line) {
        const text = String(line || '');
        const index = text.indexOf(PLAYER_LIST_MARKER);
        if (index === -1) return false;

        const names = text.slice(index + PLAYER_LIST_MARKER.length).trim();
        if (!names) return false;

        // The command itself can come back through command spy, and then what
        // follows the marker is the tellraw payload rather than a name list. Only
        // real names are taken, so that echo cannot become players.
        let added = 0;
        for (const raw of names.split(',')) {
            const name = raw.replace(/\u00a7[0-9a-fk-or]/gi, '').trim();
            if (!/^\w{1,16}$/.test(name)) continue;

            const key = name.toLowerCase();
            const existing = this.online.get(key);
            this.online.set(key, {
                name,
                uuid: existing?.uuid ?? this.uuidFor(name),
                vanished: !this.listed.has(key)
            });
            if (!existing) this.ipLookup?.queue(name);
            added += 1;
        }

        if (!added) return false;

        this.log.debug(`player scan: ${this.online.size} online, ${[...this.online.values()].filter(p => p.vanished).length} vanished`);
        return true;
    }

    // Runs something a player clicked as that player, with their own rank. The
    // button's token was issued to exactly one player and only answers for them,
    // so the name on the echo line is trustworthy even though it is not signed
    // chat - that is what keeps an owner an owner when they click.
    runSuggestion(suggestion, clicker) {
        const message = String(suggestion || '').trim();
        if (!message || !clicker?.name) return false;

        const parsed = {
            username: clicker.name,
            message,
            uuid: clicker.uuid ?? this.uuidFor(clicker.name)
        };
        this.registry
            .dispatch({ bot: this, parsed, verified: false, clicked: true, trustedClicker: true })
            .catch(error => this.log.error(`clicked command failed: ${error.message}`));
        return true;
    }

    // The server keeps the nickname, so it only has to be set once per session.
    nickName() {
        const nick = this.server.nick ?? this.config.bot?.nick;
        if (typeof nick !== 'string') return null;
        const trimmed = nick.trim();
        return trimmed || null;
    }

    applyNick() {
        const nick = this.nickName();
        if (!nick || this.nickSent) return;
        this.nickSent = true;
        setTimeout(() => {
            if (this.state !== 'ready') return;
            this.log.info(`setting nickname to ${nick}`);
            this.sendChat(`/nick ${nick}`);
        }, 1000).unref?.();
    }

    // The chat tag, set with /prefix. Per server wins, same as the nick.
    tagPrefix() {
        if (this.config.bot?.prefixEnabled === false) return null;
        const tag = this.server.prefix ?? this.config.bot?.prefix;
        if (typeof tag !== 'string') return null;
        const trimmed = tag.trim();
        return trimmed || null;
    }

    // The server keeps the prefix, so it is only sent once per session - and a
    // moment after the nick, since both plugins can be picky about order.
    applyPrefixTag() {
        const tag = this.tagPrefix();
        if (!tag || this.prefixSent) return;
        this.prefixSent = true;
        setTimeout(() => {
            if (this.state !== 'ready') return;
            this.log.info(`setting chat prefix to ${tag}`);
            this.sendChat(`/prefix ${tag}`);
        }, 1200).unref?.();
    }

    // Whether the connected version has a packet at all. Writing one it does not
    // have only warns, so it is checked first.
    supportsPacket(name) {
        try {
            // eslint-disable-next-line global-require
            const data = require('minecraft-data')(this.client?.version || this.config.minecraft?.version);
            return Boolean(data?.protocol?.play?.toServer?.types?.[`packet_${name}`]);
        } catch {
            return false;
        }
    }

    // A server ignores block placement and interaction until the client reports
    // that the world has loaded; vanilla clients send this once, after chunks.
    sendPlayerLoaded() {
        if (this.loadedSent) return false;
        this.loadedSent = true;
        if (!this.supportsPlayerLoaded) return false;
        return this.write('player_loaded', {});
    }

    // Raw packet write, used by the core to fill command blocks.
    write(name, payload) {
        if (!this.client || this.state !== 'ready') return false;
        try {
            this.client.write(name, payload);
            return true;
        } catch (error) {
            this.log.warn(`cannot write ${name}: ${error.message}`);
            return false;
        }
    }

    // Commands only ever run through a core command block. Chat is never used
    // for them and never for talking: the two exceptions are the core's own
    // fill and selfcare's nick/prefix upkeep, and both call sendChat() directly.
    chat(message) {
        const text = String(message ?? '');
        if (!text.startsWith('/')) return false;

        if (!this.core || !this.core.ready) {
            if (!this.warnedNoCore) {
                this.warnedNoCore = true;
                this.log.warn('core is not ready; commands are held back instead of using chat');
            }
            return false;
        }

        return Boolean(this.core.run(text.slice(1)));
    }

    // Plain chat, never routed through the core. Reserved for the paths that
    // cannot use a block: core refills (the fill has to reach the server even
    // when the core is the broken thing) and selfcare's nick/prefix.
    sendChat(message) {
        const text = String(message ?? '');
        if (!text) return false;
        if (!this.client || this.state !== 'ready') return false;
        this.client.chat(text);
        return true;
    }

    scheduleReconnect() {
        if (this.destroyed || this.reconnectTimer) return;
        const { reconnectDelayMs, maxReconnectDelayMs, maxAttempts } = this.connection;

        if (maxAttempts > 0 && this.attempts >= maxAttempts) {
            this.log.error(`giving up after ${this.attempts} reconnect attempts`);
            this.emit('failed');
            return;
        }

        const backoff = Math.min(reconnectDelayMs * 2 ** this.attempts, maxReconnectDelayMs);
        const delay = Math.round(backoff * (0.8 + Math.random() * 0.4));
        this.attempts += 1;
        this.state = 'reconnecting';
        this.log.info(`reconnecting in ${delay}ms (attempt ${this.attempts})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.destroyed) this.connect();
        }, delay);
    }

    stop(reason = 'stopped') {
        this.log.info(reason);
        this.clearLoginWatchdog();
        this.connecting = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.client) {
            const client = this.client;
            this.client = null;
            this.state = 'offline';
            try { client.end('vbot shutdown'); } catch { /* already gone */ }
        }
    }

    destroy() {
        this.destroyed = true;
        this.stop('destroyed');
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
        }
        this.filter?.destroy();
        this.whitelist?.destroy();
        this.cloops?.destroy();
        this.core?.destroy();
        this.clickTokens?.destroy();
        this.selfCare?.destroy();
        this.cspy?.destroy();
        this.filterGuard?.destroy();
        this.ipLookup?.destroy();
        this.removeAllListeners();
    }
}

function positive(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = { Bot, CHAT_PACKETS };
