'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
    name_key   TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    uuid       TEXT,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    messages   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
    name_key   TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    uuid       TEXT,
    level      INTEGER NOT NULL,
    granted_by TEXT,
    granted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_players_uuid ON players(uuid);
CREATE INDEX IF NOT EXISTS idx_users_uuid ON users(uuid);
`;

class Store {
    constructor(file) {
        this.file = file;
        this.db = null;
    }

    open() {
        if (path.dirname(this.file) && path.dirname(this.file) !== '.') {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
        }
        this.db = new DatabaseSync(this.file);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec(SCHEMA);
        return this;
    }

    close() {
        if (this.db) this.db.close();
        this.db = null;
    }

    static key(name) {
        return String(name || '').trim().toLowerCase();
    }

    // Records a chat sighting: creates the player row or bumps its counter.
    touchPlayer(name, uuid = null) {
        const key = Store.key(name);
        if (!key) return null;
        const now = Date.now();
        this.db.prepare(`
            INSERT INTO players (name_key, name, uuid, first_seen, last_seen, messages)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(name_key) DO UPDATE SET
                name      = excluded.name,
                uuid      = COALESCE(excluded.uuid, players.uuid),
                last_seen = excluded.last_seen,
                messages  = players.messages + 1
        `).run(key, name, uuid, now, now);
        return this.getPlayer(name);
    }

    getPlayer(name) {
        const key = Store.key(name);
        if (!key) return null;
        return this.db.prepare('SELECT * FROM players WHERE name_key = ?').get(key) || null;
    }

    setPlayerUUID(name, uuid) {
        const key = Store.key(name);
        if (!key || !uuid) return;
        this.db.prepare('UPDATE players SET uuid = ? WHERE name_key = ?').run(uuid, key);
        this.db.prepare('UPDATE users SET uuid = ? WHERE name_key = ?').run(uuid, key);
    }

    // Records a name/uuid pair seen in the player list without counting a chat
    // message, then carries the uuid over to any stored rank for that name.
    linkPlayer(name, uuid) {
        const key = Store.key(name);
        if (!key || !uuid) return null;
        const now = Date.now();
        this.db.prepare(`
            INSERT INTO players (name_key, name, uuid, first_seen, last_seen, messages)
            VALUES (?, ?, ?, ?, ?, 0)
            ON CONFLICT(name_key) DO UPDATE SET
                name = excluded.name,
                uuid = excluded.uuid
        `).run(key, name, uuid, now, now);
        this.db.prepare('UPDATE users SET uuid = ? WHERE name_key = ?').run(uuid, key);
        return this.getPlayer(name);
    }

    getPlayerByUUID(uuid) {
        if (!uuid) return null;
        return this.db.prepare(
            'SELECT * FROM players WHERE uuid = ? ORDER BY last_seen DESC LIMIT 1'
        ).get(uuid) || null;
    }

    getUserByUUID(uuid) {
        if (!uuid) return null;
        return this.db.prepare(
            'SELECT * FROM users WHERE uuid = ? ORDER BY granted_at DESC LIMIT 1'
        ).get(uuid) || null;
    }

    getUser(name) {
        const key = Store.key(name);
        if (!key) return null;
        return this.db.prepare('SELECT * FROM users WHERE name_key = ?').get(key) || null;
    }

    setUserLevel(name, level, grantedBy = null) {
        const key = Store.key(name);
        if (!key) return null;
        this.db.prepare(`
            INSERT INTO users (name_key, name, uuid, level, granted_by, granted_at)
            VALUES (?, ?, NULL, ?, ?, ?)
            ON CONFLICT(name_key) DO UPDATE SET
                name       = excluded.name,
                level      = excluded.level,
                granted_by = excluded.granted_by,
                granted_at = excluded.granted_at
        `).run(key, name, level, grantedBy, Date.now());
        return this.getUser(name);
    }

    listUsers(level = null) {
        if (level === null) {
            return this.db.prepare('SELECT * FROM users ORDER BY level DESC, name_key').all();
        }
        return this.db.prepare('SELECT * FROM users WHERE level = ? ORDER BY name_key').all(level);
    }

    getMeta(key, fallback = null) {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
        return row ? row.value : fallback;
    }

    setMeta(key, value) {
        this.db.prepare(`
            INSERT INTO meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, String(value));
    }
}

module.exports = { Store };
