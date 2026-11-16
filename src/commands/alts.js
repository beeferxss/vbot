'use strict';

// Who is behind an address, or what addresses are behind a name.
//
// The reference bot prints two long lists; this is the same information in one
// block: a player's addresses with the other accounts on each, or an address
// with every account that used it. Clicking an IP opens its account list and
// clicking an account opens its addresses, so you can walk a cluster.

const { looksLikeIp } = require('../ip');

const MAX_IPS = 8;
const MAX_ALTS = 10;
const ONLINE_COLOUR = 'green';
const IP_COLOUR = 'aqua';

function timeAgo(ms) {
    if (!ms) return 'unknown';
    const diff = Math.max(0, Date.now() - Number(ms));
    const units = [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];
    for (const [label, size] of units) {
        if (diff >= size) return `${Math.floor(diff / size)}${label} ago`;
    }
    return 'just now';
}

function onlineNames(bot) {
    // Bot.online is lower-case name -> { name, uuid }.
    return new Set(bot.online instanceof Map ? bot.online.keys() : []);
}

function account({ name, prefix }) {
    return {
        text: name,
        color: 'white',
        hover: { text: `Show the addresses of ${name}` },
        click: { action: 'suggest_command', value: `${prefix}alts ${name}` }
    };
}

async function byPlayer(ctx, player) {
    const lookup = ctx.bot.ipLookup;
    const known = lookup ? lookup.historyFor(player) : [];
    const ips = known.length ? known : [];

    const parts = [
        { text: 'alts ', color: 'gold' },
        { text: player, color: 'white' },
        { text: ips.length ? ` — ${ips.length} address(es)` : ' — no addresses stored yet', color: 'gray' }
    ];

    if (!ips.length) {
        parts.push({
            text: lookup?.usable
                ? `\nCould not read one back from the lookup command.`
                : '\nIP lookup is off in config (alts.lookupCommand).',
            color: 'dark_gray'
        });
        ctx.reply(parts);
        return;
    }

    const online = onlineNames(ctx.bot);
    for (const row of ips.slice(0, MAX_IPS)) {
        const others = ctx.store
            .playersForIp(row.ip)
            .filter(entry => entry.name && entry.name.toLowerCase() !== player.toLowerCase());

        parts.push({ text: '\n' });
        parts.push({
            text: row.ip,
            color: IP_COLOUR,
            hover: { text: `Show every account on ${row.ip}` },
            click: { action: 'suggest_command', value: `${ctx.prefix}alts ${row.ip}` }
        });
        parts.push({ text: ` (${timeAgo(row.last_seen)})`, color: 'dark_gray' });

        if (!others.length) {
            parts.push({ text: ' — no other accounts', color: 'dark_gray' });
            continue;
        }

        parts.push({ text: ' — also ', color: 'gray' });
        others.slice(0, MAX_ALTS).forEach((other, index) => {
            if (index) parts.push({ text: ', ', color: 'dark_gray' });
            const entryPart = account({ name: other.name, prefix: ctx.prefix });
            if (online.has(other.name.toLowerCase())) {
                entryPart.color = ONLINE_COLOUR;
                entryPart.hover.text += ' (online)';
            }
            parts.push(entryPart);
        });
        if (others.length > MAX_ALTS) {
            parts.push({ text: ` +${others.length - MAX_ALTS} more`, color: 'dark_gray' });
        }
    }

    ctx.reply(parts);
}

function byIp(ctx, ip) {
    const accounts = ctx.store.playersForIp(ip);
    const parts = [
        { text: 'ip ', color: 'gold' },
        { text: ip, color: IP_COLOUR },
        { text: accounts.length ? ` — ${accounts.length} account(s)` : ' — nobody seen', color: 'gray' }
    ];

    const online = onlineNames(ctx.bot);
    for (const row of accounts.slice(0, MAX_ALTS)) {
        const name = row.name || '(unknown)';
        const isOnline = online.has(name.toLowerCase());
        parts.push({ text: '\n' });
        parts.push(account({ name, prefix: ctx.prefix }));
        parts.push({ text: ` ${timeAgo(row.last_seen)}`, color: 'dark_gray' });
        if (isOnline) parts.push({ text: ' (online)', color: ONLINE_COLOUR });
    }

    if (accounts.length > MAX_ALTS) {
        parts.push({ text: `\n+${accounts.length - MAX_ALTS} more`, color: 'dark_gray' });
    }

    ctx.reply(parts);
}

module.exports = {
    name: 'alts',
    description: 'Show the addresses behind a player, or the accounts behind an address',
    usage: 'alts <player|ip>',
    level: 'public',

    async execute(ctx) {
        const target = String(ctx.args[0] || '').trim();
        if (!target) {
            ctx.reply(`Usage: ${ctx.prefix}alts <player|ip>`);
            return;
        }

        if (looksLikeIp(target)) {
            byIp(ctx, target);
            return;
        }

        const lookup = ctx.bot.ipLookup;
        if (!lookup) {
            ctx.reply('IP lookup is not loaded.');
            return;
        }

        if (lookup.usable) {
            // A named lookup is the moment to ask the server, not before.
            await lookup.lookup(target, { force: true });
        }

        await byPlayer(ctx, target);
    }
};
