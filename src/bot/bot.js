'use strict';

const EventEmitter = require('node:events');
const mc = require('minecraft-protocol');
const { chatTextFromPacket, chatEventFromPacket, parseChatLine } = require('../minecraft/chat');
const { normalizeUuid, offlineUuid } = require('../minecraft/uuid');
const { playerInfoEntries } = require('../minecraft/players');

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

        this.client = null;
        this.state = 'idle';
        this.attempts = 0;
        this.reconnectTimer = null;
        this.destroyed = false;
        this.disconnectReason = null;
        this.known = new Map();
        // Set once a signed player chat packet arrives: until then the server may
        // simply not support chat signing, so unsigned chat is all there is.
        this.signedChatSeen = false;
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
            this.log.info('connected');
            this.store.touchPlayer(this.server.username, this.uuidFor(this.server.username));
            this.emit('ready');
        });

        for (const event of ['player_info', 'player_info_update']) {
            client.on(event, packet => this.handlePlayerInfo(packet));
        }

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

    chat(message) {
        if (!this.client || this.state !== 'ready') return false;
        this.client.chat(String(message));
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
        this.removeAllListeners();
    }
}

module.exports = { Bot, CHAT_PACKETS };
