'use strict';

const { normalizeUuid } = require('./minecraft/uuid');

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

class Permissions {
    constructor({ config, store, logger }) {
        this.config = config.permissions || {};
        this.store = store;
        this.logger = logger;
    }

    // Highest of: configured lists, stored grant. A name or a uuid can appear in
    // the config lists; stored grants are matched by uuid first, so a player who
    // renames keeps their rank.
    levelFor({ name, uuid } = {}) {
        const key = String(name || '').toLowerCase();
        const id = normalizeUuid(uuid);
        let level = LEVEL.PUBLIC;

        for (const rank of ['owner', 'admin', 'trusted']) {
            const list = Array.isArray(this.config[rank]) ? this.config[rank] : [];
            const hit = list.some(entry => {
                const value = String(entry);
                if (value.toLowerCase() === key) return true;
                return id !== null && normalizeUuid(value) === id;
            });
            if (hit) level = Math.max(level, parseLevel(rank));
        }

        const byName = this.store?.getUser(name);
        if (byName) level = Math.max(level, parseLevel(byName.level) ?? LEVEL.PUBLIC);

        if (id) {
            const byUuid = this.store?.getUserByUUID(id);
            if (byUuid) level = Math.max(level, parseLevel(byUuid.level) ?? LEVEL.PUBLIC);
        }

        return level;
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
