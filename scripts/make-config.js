'use strict';

// Builds config.json for a workflow run from config.example.json.
// The committed config is the source of truth: hosts, ports, usernames and
// enabled flags are used exactly as they are there. Secrets only fill in the
// in-game auth keys, which must never be committed.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Servers shipped with username "random" get a distinct name per run so the
// bots do not all fight over the same account.
function randomUsername(length = 8) {
    return `bot_${Array.from({ length }, () => ALNUM[crypto.randomInt(ALNUM.length)]).join('')}`;
}

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
const enabled = config.minecraft.servers.filter(server => server.enabled);

if (!enabled.length) {
    console.error('no servers are enabled in config.example.json');
    console.error('set "enabled": true on at least one server and push again');
    process.exit(1);
}

for (const server of enabled) {
    if (server.username === 'random') server.username = randomUsername();
}

const keys = {
    owner: process.env.BOT_OWNER_KEY,
    admin: process.env.BOT_ADMIN_KEY,
    trusted: process.env.BOT_TRUSTED_KEY
};
for (const [name, value] of Object.entries(keys)) {
    if (value) config.permissions.keys[name] = value;
}

if (process.env.BOT_PREFIXES) {
    config.bot.prefixes = process.env.BOT_PREFIXES.split(',').map(value => value.trim()).filter(Boolean);
}

fs.writeFileSync(path.join(ROOT, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

console.log(`config.json written: ${enabled.length} server(s) enabled`);
for (const server of enabled) {
    console.log(`  ${server.id} -> ${server.host}:${server.port} as ${server.username}`);
}
