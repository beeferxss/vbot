'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Only what has to survive a restart: who a player is, and what rank they hold.
// Counters and scratch values are deliberately not persisted.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
    name_key   TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    uuid       TEXT,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    name_key   TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    uuid       TEXT,
    level      INTEGER NOT NULL,
    granted_by TEXT,
    granted_at INTEGER NOT NULL
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_players_uuid ON players(uuid);
CREATE INDEX IF NOT EXISTS idx_users_uuid ON users(uuid);
`;

const PLAYERS_COLUMNS = 'name_key, name, uuid, first_seen, last_seen';

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
        this.migrate();
        this.db.exec(INDEXES);
        return this;
    }

    // Older databases carried a message counter on players and a meta table.
    // Neither is persisted any more, so drop them instead of carrying dead data.
    migrate() {
        const columns = this.db.prepare('PRAGMA table_info(players)').all().map(row => row.name);

        if (columns.includes('messages')) {
            this.db.exec('BEGIN');
            try {
                this.db.exec(`
                    CREATE TABLE players_trimmed (
                        name_key   TEXT PRIMARY KEY,
                        name       TEXT NOT NULL,
                        uuid       TEXT,
                        first_seen INTEGER NOT NULL,
                        last_seen  INTEGER NOT NULL
                    );
                    INSERT INTO players_trimmed (${PLAYERS_COLUMNS})
                        SELECT ${PLAYERS_COLUMNS} FROM players;
                    DROP TABLE players;
                    ALTER TABLE players_trimmed RENAME TO players;
                `);
                this.db.exec('COMMIT');
            } catch (error) {
                this.db.exec('ROLLBACK');
                throw error;
            }
        }

        this.db.exec('DROP TABLE IF EXISTS meta');
    }

    // Folds the write-ahead log into the main file so a copy of the database
    // is complete even if it is taken while this process is still running.
    checkpoint() {
        if (!this.db) return;
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }

    close() {
        if (!this.db) return;
        try {
            this.checkpoint();
        } catch {
            // closing is best effort; the file is still usable
        }
        this.db.close();
        this.db = null;
    }

    static key(name) {
        return String(name || '').trim().toLowerCase();
    }

    // Records that a player was seen, creating the row on first sight.
    touchPlayer(name, uuid = null) {
        const key = Store.key(name);
        if (!key) return null;
        const now = Date.now();
        this.db.prepare(`
            INSERT INTO players (name_key, name, uuid, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(name_key) DO UPDATE SET
                name      = excluded.name,
                uuid      = COALESCE(excluded.uuid, players.uuid),
                last_seen = excluded.last_seen
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

    // Records a name/uuid pair seen in the player list, then carries the uuid
    // over to any stored rank for that name.
    linkPlayer(name, uuid) {
        const key = Store.key(name);
        if (!key || !uuid) return null;
        const now = Date.now();
        this.db.prepare(`
            INSERT INTO players (name_key, name, uuid, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?)
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

    getUser(name) {
        const key = Store.key(name);
        if (!key) return null;
        return this.db.prepare('SELECT * FROM users WHERE name_key = ?').get(key) || null;
    }

    getUserByUUID(uuid) {
        if (!uuid) return null;
        return this.db.prepare(
            'SELECT * FROM users WHERE uuid = ? ORDER BY granted_at DESC LIMIT 1'
        ).get(uuid) || null;
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
}

module.exports = { Store };
