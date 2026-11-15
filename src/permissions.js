'use strict';

const crypto = require('node:crypto');

const LEVEL = {
    PUBLIC: 0,
    TRUSTED: 1,
    ADMIN: 2,
    OWNER: 3
};

const NAMES = ['public', 'trusted', 'admin', 'owner'];

function levelName(level) {
    return NAMES[level] ?? 'public';
}

function parseLevel(value) {
    if (typeof value === 'number' && Number.isInteger(value)) {
        return value >= LEVEL.PUBLIC && value <= LEVEL.OWNER ? value : null;
    }
    const index = NAMES.indexOf(String(value || '').toLowerCase());
    return index === -1 ? null : index;
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

class Permissions {
    constructor({ config, store, logger }) {
        this.config = config.permissions || {};
        this.store = store;
        this.logger = logger;
    }

    // Highest of: configured lists, stored grant. Names are matched
    // case-insensitively; uuid is used when we have one.
    levelFor({ name, uuid } = {}) {
        const key = String(name || '').toLowerCase();
        let level = LEVEL.PUBLIC;

        for (const rank of ['owner', 'admin', 'trusted']) {
            const list = Array.isArray(this.config[rank]) ? this.config[rank] : [];
            const hit = list.some(entry => String(entry).toLowerCase() === key);
            if (hit) level = Math.max(level, parseLevel(rank));
        }

        const stored = this.store?.getUser(name);
        if (stored) {
            if (uuid && !stored.uuid) this.store.setPlayerUUID(name, uuid);
            level = Math.max(level, parseLevel(stored.level) ?? LEVEL.PUBLIC);
        }

        return level;
    }

    keyForLevel(level) {
        const keys = this.config.keys || {};
        const name = levelName(level);
        return name === 'public' ? '' : String(keys[name] || '');
    }

    // Redeems an auth key in-game. Returns the granted level or null.
    redeem({ name, uuid, key }) {
        const provided = String(key || '').trim();
        if (!provided) return null;

        for (const level of [LEVEL.TRUSTED, LEVEL.ADMIN, LEVEL.OWNER]) {
            const expected = this.keyForLevel(level);
            if (expected && safeEqual(expected, provided)) {
                this.store.setUserLevel(name, level, 'key');
                if (uuid) this.store.setPlayerUUID(name, uuid);
                this.logger.info(`${name} authenticated as ${levelName(level)}`);
                return level;
            }
        }
        return null;
    }

    grant(name, level, grantedBy = null) {
        const parsed = parseLevel(level);
        if (parsed === null || parsed === LEVEL.PUBLIC) {
            this.store.setUserLevel(name, LEVEL.PUBLIC, grantedBy);
            return LEVEL.PUBLIC;
        }
        this.store.setUserLevel(name, parsed, grantedBy);
        return parsed;
    }
}

module.exports = { LEVEL, NAMES, Permissions, levelName, parseLevel };
