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
    last_seen  INTEGER NOT NULL,
    version    TEXT,
    version_at INTEGER
);

CREATE TABLE IF NOT EXISTS player_ips (
    name_key   TEXT NOT NULL,
    ip         TEXT NOT NULL,
    uuid       TEXT,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    PRIMARY KEY (name_key, ip)
);

CREATE TABLE IF NOT EXISTS mails (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    to_key    TEXT NOT NULL,
    from_name TEXT NOT NULL,
    text      TEXT NOT NULL,
    sent_at   INTEGER NOT NULL,
    read_at   INTEGER
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
CREATE INDEX IF NOT EXISTS idx_player_ips_ip ON player_ips(ip);
CREATE INDEX IF NOT EXISTS idx_mails_to ON mails(to_key);
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
    // The version columns are newer than the rest, so they are added in place.
    migrate() {
        let columns = this.columns('players');

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
            columns = this.columns('players');
        }

        this.db.exec('DROP TABLE IF EXISTS meta');

        if (!columns.includes('version')) this.db.exec('ALTER TABLE players ADD COLUMN version TEXT');
        if (!columns.includes('version_at')) this.db.exec('ALTER TABLE players ADD COLUMN version_at INTEGER');
    }

    columns(table) {
        return this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
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

    // An IP is the only thing that links two accounts, so it is the one extra
    // fact worth keeping. Both name and ip identify the row.
    recordIp(name, ip, uuid = null) {
        const key = Store.key(name);
        const address = String(ip || '').trim();
        if (!key || !address) return null;

        // An address is only useful next to the account that used it, so the
        // player row is created here if nothing else has seen them yet.
        if (!this.getPlayer(name)) this.touchPlayer(name, uuid);

        const now = Date.now();
        this.db.prepare(`
            INSERT INTO player_ips (name_key, ip, uuid, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(name_key, ip) DO UPDATE SET
                uuid      = COALESCE(excluded.uuid, player_ips.uuid),
                last_seen = excluded.last_seen
        `).run(key, address, uuid, now, now);
        return { name_key: key, ip: address };
    }

    ipsFor(name) {
        const key = Store.key(name);
        if (!key) return [];
        return this.db.prepare(`
            SELECT ip, first_seen, last_seen FROM player_ips
            WHERE name_key = ? ORDER BY last_seen DESC
        `).all(key);
    }

    // The version a player last joined on, read from viaver. The row is created
    // here if nothing else has seen them yet, and the time is what `alts` shows
    // as "last known".
    recordVersion(name, version) {
        const key = Store.key(name);
        const text = String(version || '').trim();
        if (!key || !text) return null;

        if (!this.getPlayer(name)) this.touchPlayer(name);
        this.db.prepare('UPDATE players SET version = ?, version_at = ? WHERE name_key = ?')
            .run(text, Date.now(), key);
        return this.getPlayer(name);
    }

    playersForIp(ip) {
        const address = String(ip || '').trim();
        if (!address) return [];
        return this.db.prepare(`
            SELECT p.name, p.uuid, p.last_seen, i.first_seen AS ip_first_seen
            FROM player_ips i LEFT JOIN players p ON p.name_key = i.name_key
            WHERE i.ip = ? ORDER BY i.last_seen DESC
        `).all(address);
    }

    // Offline messages. A mailbox follows the name, like ranks do: sending to
    // "steve" reaches the player who joins as Steve, and the sender's spelling
    // is kept for the line the mailbox prints.
    sendMail(from, to, text) {
        const key = Store.key(to);
        const message = String(text || '').trim();
        if (!key || !message) return null;

        const fromName = String(from || '').trim() || 'console';
        const info = this.db.prepare(`
            INSERT INTO mails (to_key, from_name, text, sent_at, read_at)
            VALUES (?, ?, ?, ?, NULL)
        `).run(key, fromName, message, Date.now());
        return { id: Number(info.lastInsertRowid), from: fromName, text: message };
    }

    mailsFor(name) {
        const key = Store.key(name);
        if (!key) return [];
        return this.db.prepare('SELECT * FROM mails WHERE to_key = ? ORDER BY sent_at').all(key);
    }

    unreadMailCount(name) {
        const key = Store.key(name);
        if (!key) return 0;
        const row = this.db.prepare('SELECT COUNT(*) AS count FROM mails WHERE to_key = ? AND read_at IS NULL').get(key);
        return Number(row?.count || 0);
    }

    markMailsRead(name) {
        const key = Store.key(name);
        if (!key) return 0;
        const info = this.db
            .prepare('UPDATE mails SET read_at = ? WHERE to_key = ? AND read_at IS NULL')
            .run(Date.now(), key);
        return Number(info.changes || 0);
    }

    // Read mail is the default to clear; `all` takes the unread as well.
    clearMails(name, { all = false } = {}) {
        const key = Store.key(name);
        if (!key) return 0;
        const info = all
            ? this.db.prepare('DELETE FROM mails WHERE to_key = ?').run(key)
            : this.db.prepare('DELETE FROM mails WHERE to_key = ? AND read_at IS NOT NULL').run(key);
        return Number(info.changes || 0);
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
