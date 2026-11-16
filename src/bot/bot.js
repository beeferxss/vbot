'use strict';

const EventEmitter = require('node:events');
const mc = require('minecraft-protocol');
const { chatTextFromPacket, chatEventFromPacket, parseChatLine } = require('../minecraft/chat');
const { normalizeUuid, offlineUuid } = require('../minecraft/uuid');
const { playerInfoEntries } = require('../minecraft/players');
const { Core } = require('../core');
const { ClickTokens } = require('../clicktokens');

const CHAT_PACKETS = ['chat', 'player_chat', 'profileless_chat', 'system_chat', 'disguised_chat'];

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

        this.client = null;
        this.position = null;
        this.state = 'idle';
        this.attempts = 0;
        this.reconnectTimer = null;
        this.destroyed = false;
        this.disconnectReason = null;
        this.known = new Map();
        // Set once a signed player chat packet arrives: until then the server may
        // simply not support chat signing, so unsigned chat is all there is.
        this.signedChatSeen = false;
        this.nickSent = false;
    }

    get connection() {
        return this.config.minecraft.connection;
    }

    start() {
        if (this.destroyed || this.client || this.reconnectTimer) return false;
        this.connect();
        return true;
    }

    connect() {
        this.reconnectTimer = null;
        const { server } = this;

        const options = {
            host: server.host,
            port: server.port,
            username: server.username,
            auth: server.auth
        };
        const version = server.version || this.config.minecraft.version;
        if (version) options.version = version;

        this.state = 'connecting';
        this.log.info(`connecting to ${server.host}:${server.port} as ${server.username}`);

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
    }

    bind(client) {
        // Errors can still arrive after 'end' (minecraft-protocol re-emits the
        // auto-version ping failure), so listeners are never stripped: a stale
        // client is recognised by identity instead of by removing handlers.
        const isCurrent = () => this.client === client;

        client.on('login', () => {
            this.attempts = 0;
            this.state = 'ready';
            this.disconnectReason = null;
            this.log.info(`connected as ${this.server.username}`);
            this.emit('ready');
            this.applyNick();
            // Give the position packet a moment to arrive before placing anything.
            setTimeout(() => this.core?.onReady(), 1500).unref?.();
        });

        for (const event of ['player_info', 'player_info_update']) {
            client.on(event, packet => this.handlePlayerInfo(packet));
        }

        for (const event of ['position', 'position_look']) {
            client.on(event, packet => {
                if (Number.isFinite(packet?.x) && Number.isFinite(packet?.y) && Number.isFinite(packet?.z)) {
                    this.position = { x: packet.x, y: packet.y, z: packet.z };
                }
            });
        }

        client.on('block_change', packet => this.core?.onBlockChange(packet));

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
            this.client = null;
            this.state = 'offline';
            this.log.warn(`disconnected (${this.disconnectReason || 'socket closed'})`);
            this.emit('disconnect', this.disconnectReason);
            this.nickSent = false;
            this.core?.destroy();
            this.clickTokens?.clear();
            if (this.connection.autoReconnect && !this.destroyed) this.scheduleReconnect();
        });
    }

    handleChatEvent(event, packet) {
        const chat = chatEventFromPacket(event, packet);
        if (!chat || !chat.line) return;

        // A signed chat packet is the only place a name and uuid are worth
        // trusting, and it also keeps the identity cache warm between logins.
        if (chat.verified) this.signedChatSeen = true;

        if (chat.verified && chat.username && chat.uuid) {
            this.known.set(chat.username.toLowerCase(), chat.uuid);
            this.store.linkPlayer(chat.username, chat.uuid);
        }

        if (this.config.logging?.chat) {
            this.log.info(`${chat.verified ? '' : '(system) '}${chat.line}`);
        }

        // A button was clicked: the matching /random line names the clicker and
        // the action, and never needs to be dispatched as a command.
        if (this.clickTokens?.handle(chat.line)) return;

        // Fill results are the only confirmation that a refill actually ran.
        this.core?.noteMessage(chat.line);

        const parsed = chat.verified && chat.username
            ? { username: chat.username, message: chat.message }
            : parseChatLine(chat.line);

        if (parsed) {
            const uuid = chat.uuid || (chat.verified ? null : null) || this.uuidFor(parsed.username);
            parsed.uuid = uuid;
            this.store.touchPlayer(parsed.username, uuid);
        }

        this.emit('chat', { line: chat.line, parsed, verified: chat.verified });

        if (parsed) {
            this.registry
                .dispatch({ bot: this, parsed, line: chat.line, verified: chat.verified })
                .catch(error => this.log.error(`command dispatch failed: ${error.stack || error.message}`));
        }
    }

    // Online-mode servers send real UUIDs in the player list; offline-mode
    // servers derive them from the name, so nothing needs to arrive at all.
    handlePlayerInfo(packet) {
        for (const { name, uuid } of playerInfoEntries(packet)) {
            if (this.known.get(name.toLowerCase()) === uuid) continue;
            this.known.set(name.toLowerCase(), uuid);
            this.store.linkPlayer(name, uuid);
            this.log.debug(`identity ${name} -> ${uuid}`);
            this.emit('player', { name, uuid });
        }
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

    // Runs something a player clicked as that player, with their own rank. The
    // click line is server output, so it is not a signed message: ranks that
    // depend on signed chat still need a token.
    runSuggestion(suggestion, clicker) {
        const message = String(suggestion || '').trim();
        if (!message || !clicker?.name) return false;

        const parsed = {
            username: clicker.name,
            message,
            uuid: clicker.uuid ?? this.uuidFor(clicker.name)
        };
        this.registry
            .dispatch({ bot: this, parsed, verified: false, clicked: true })
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
            this.chat(`/nick ${nick}`);
        }, 1000).unref?.();
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

    // Anything the bot says. A server command (leading /) is run through a core
    // command block once the core is up, so it never appears as bot chat; chat
    // is the fallback before that and for normal messages.
    chat(message) {
        const text = String(message ?? '');
        if (!text) return false;

        if (text.startsWith('/') && this.core && this.core.ready) {
            const cell = this.core.run(text.slice(1));
            if (cell) return true;
        }

        return this.sendChat(text);
    }

    // Plain chat, never routed through the core. Core refills use this: the fill
    // has to reach the server even when the core itself is the thing broken.
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
        this.core?.destroy();
        this.clickTokens?.destroy();
        this.removeAllListeners();
    }
}

module.exports = { Bot, CHAT_PACKETS };
