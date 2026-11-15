'use strict';

// Builds config.json for a workflow run from config.example.json.
// Secrets supply credentials; ENABLE_SERVERS decides which servers run.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomUsername(length = 8) {
    return `bot_${Array.from({ length }, () => ALNUM[crypto.randomInt(ALNUM.length)]).join('')}`;
}

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));

const requested = String(process.env.ENABLE_SERVERS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

// With no selection, run every server in the example config.
const enableAll = requested.length === 0 || requested.includes('all');

const enabled = [];
for (const server of config.minecraft.servers) {
    server.enabled = enableAll ? true : requested.includes(server.id);
    if (!server.enabled) continue;
    if (server.username === 'random') server.username = randomUsername();
    enabled.push(server);
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
if (!enabled.length) console.error('warning: no servers enabled, the bot will exit immediately');
