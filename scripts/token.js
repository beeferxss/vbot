'use strict';

// Prints the token for a rank, generated from the key in config.json.
// Usage: npm run token -- admin

const { loadConfig, ConfigError } = require('../src/config');
const { Tokens } = require('../src/auth/tokens');
const { LEVEL, levelName, parseLevel } = require('../src/permissions');

const requested = process.argv[2] || 'admin';
const level = parseLevel(requested);

if (level === null || level === LEVEL.PUBLIC) {
    console.error('usage: npm run token -- <trusted|admin|owner>');
    process.exit(1);
}

let config;
try {
    config = loadConfig();
} catch (error) {
    if (error instanceof ConfigError) {
        console.error(`Config error: ${error.message}`);
        process.exit(1);
    }
    throw error;
}

const tokens = new Tokens({ keys: config.permissions.keys });
const issued = tokens.issue(level);

if (!issued) {
    console.error(`no key set for ${levelName(level)} (permissions.keys.${levelName(level)})`);
    process.exit(1);
}

console.log(`${levelName(level)} token: ${issued.token}`);
console.log(`valid for about ${Math.round(issued.expiresInMs / 1000)}s, single use`);
