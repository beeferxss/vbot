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

// The Discord webhook is a secret: it is a channel's posting URL, so it can never
// be committed. Without it the bridge simply stays off.
if (process.env.BOT_DISCORD_WEBHOOK) {
    config.discord.webhookUrl = process.env.BOT_DISCORD_WEBHOOK.trim();
    if (process.env.BOT_DISCORD_CHAT === 'false') config.discord.chat = false;
}

fs.writeFileSync(path.join(ROOT, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

console.log(`config.json written: ${enabled.length} server(s) enabled`);
for (const server of enabled) {
    console.log(`  ${server.id} -> ${server.host}:${server.port} as ${server.username}`);
}
