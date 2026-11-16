'use strict';

const crypto = require('node:crypto');
const { LEVEL, levelName } = require('../permissions');

// Trusted tokens are 8 characters and change every 10 seconds; admin and owner
// tokens are 16 characters and change every second. A little clock skew is
// tolerated so a token generated on one machine works on another.
const RULES = [
    { level: LEVEL.OWNER, length: 16, windowMs: 1000, skew: 5 },
    { level: LEVEL.ADMIN, length: 16, windowMs: 1000, skew: 5 },
    { level: LEVEL.TRUSTED, length: 8, windowMs: 10000, skew: 2 }
];

const REUSE_MS = 5000;

function sha256(...parts) {
    return crypto.createHash('sha256').update(parts.join(''), 'utf8').digest('hex');
}

class Tokens {
    constructor({ keys = {}, logger = null } = {}) {
        this.keys = keys || {};
        this.logger = logger;
        this.used = new Map();
    }

    static tokenFor(level, key, offset = 0) {
        const rule = RULES.find(entry => entry.level === level);
        if (!rule || !key) return null;
        const step = Math.floor(Date.now() / rule.windowMs) + offset;
        const hash = level === LEVEL.TRUSTED ? sha256(key, String(step)) : sha256(String(step), key);
        return hash.slice(0, rule.length);
    }

    // Current token for a rank, for whoever holds the key locally.
    issue(level) {
        const rule = RULES.find(entry => entry.level === level);
        if (!rule) return null;
        const key = this.keys[levelName(level)];
        const token = Tokens.tokenFor(level, key);
        if (!token) return null;
        return { token, expiresInMs: rule.windowMs };
    }

    // Returns the rank a token proves, or null. A token is accepted once.
    verify(token) {
        const clean = String(token || '').trim().toLowerCase();
        if (!clean) return null;

        this.prune();
        if (this.used.has(clean)) {
            this.logger?.warn?.('auth token reused');
            return null;
        }

        for (const rule of RULES) {
            if (clean.length !== rule.length) continue;
            const key = this.keys[levelName(rule.level)];
            if (!key) continue;
            for (let offset = -rule.skew; offset <= rule.skew; offset++) {
                if (Tokens.tokenFor(rule.level, key, offset) === clean) {
                    this.used.set(clean, Date.now() + REUSE_MS);
                    return rule.level;
                }
            }
        }
        return null;
    }

    prune() {
        const now = Date.now();
        for (const [token, expiresAt] of this.used) {
            if (now >= expiresAt) this.used.delete(token);
        }
    }
}

module.exports = { Tokens };
