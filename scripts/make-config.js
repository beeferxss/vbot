'use strict';

// Builds config.json for a workflow run from config.example.json.
// The committed config is the source of truth: hosts, ports, usernames and
// enabled flags are used exactly as they are there. Secrets only fill in the
// in-game auth keys, which must never be committed.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
const enabled = config.minecraft.servers.filter(server => server.enabled);

if (!enabled.length) {
    console.error('no servers are enabled in config.example.json');
    console.error('set "enabled": true on at least one server and push again');
    process.exit(1);
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

// The Discord token is the only secret the bridge needs; channels and role ids
// stay in the committed config. Without it the bridge stays off, so a run
// without the secret is still a working bot.
const discordToken = String(process.env.DISCORD_TOKEN || '').trim();
if (discordToken) {
    config.discord = config.discord || {};
    config.discord.token = discordToken;
    config.discord.enabled = true;
}

fs.writeFileSync(path.join(ROOT, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

console.log(`config.json written: ${enabled.length} server(s) enabled`);
for (const server of enabled) {
    console.log(`  ${server.id} -> ${server.host}:${server.port} as ${server.username}`);
}
console.log(config.discord?.enabled ? 'Discord bridge enabled from DISCORD_TOKEN' : 'Discord bridge disabled: no DISCORD_TOKEN secret');
