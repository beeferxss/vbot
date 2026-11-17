'use strict';

const { normalizeUuid } = require('../minecraft/uuid');
const { levelName } = require('../permissions');

// What the bot knows, then what the server says right now. The live half comes
// from the detail command (alts.detailCommand, whois by default), which prints
// more than /seen does, so this is the command to ask when something about a
// player looks off. Addresses are never taken from it.
const FIELD_STYLE = [
    ['nick', 'nick', 'white'],
    ['gamemode', 'gamemode', 'light_purple'],
    ['health', 'health', 'green'],
    ['hunger', 'hunger', 'gold'],
    ['exp', 'exp', 'green'],
    ['ip', 'ip', 'aqua'],
    ['op', 'op', 'red'],
    ['fly', 'fly', 'aqua'],
    ['god', 'god', 'red'],
    ['speed', 'speed', 'yellow'],
    ['money', 'money', 'gold'],
    ['playtime', 'playtime', 'gray'],
    ['afk', 'afk', 'yellow'],
    ['jail', 'jail', 'red'],
    ['muted', 'muted', 'red'],
    ['whitelist', 'whitelist', 'gray'],
    ['location', 'location', 'dark_gray']
];

const RANK_COLOR = {
    public: 'gray',
    trusted: 'green',
    admin: 'red',
    owner: 'light_purple'
};

function isoDay(ms) {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

module.exports = {
    name: 'identity',
    aliases: ['whois'],
    description: 'Show what the bot knows about a player, plus their live state',
    usage: 'identity [name]',
    level: 'trusted',

    async execute(ctx) {
        const name = ctx.args[0] || ctx.username;
        const player = ctx.store.getPlayer(name);

        const lookup = ctx.bot.ipLookup;
        // Ask the server while the stored facts are being gathered.
        const pending = lookup?.usable ? lookup.details(name).catch(() => null) : Promise.resolve(null);

        const live = await pending;
        const stored = normalizeUuid(player?.uuid) || (live?.fields?.uuid ?? null);
        const uuid = stored || (typeof ctx.bot.uuidFor === 'function' ? ctx.bot.uuidFor(name) : null);

        let uuidSource = 'unknown';
        if (normalizeUuid(player?.uuid)) uuidSource = 'player list';
        else if (live?.fields?.uuid) uuidSource = sourceName(live);
        else if (uuid) uuidSource = 'derived (offline)';

        const rank = ctx.permissions.levelFor({ name, uuid });
        const lastSeen = player ? isoDay(player.last_seen) : 'never';

        const parts = [
            { text: name, color: 'white' },
            { text: ' — ', color: 'dark_gray' },
            { text: uuid || 'no uuid', color: 'aqua' },
            { text: ` (${uuidSource}), rank `, color: 'gray' },
            { text: levelName(rank), color: RANK_COLOR[levelName(rank)] || 'gray' },
            { text: `, last seen ${lastSeen}`, color: 'gray' }
        ];

        const fields = live?.fields || {};
        const shown = FIELD_STYLE.filter(([key]) => fields[key]);
        if (!shown.length) {
            parts.push({
                text: lookup?.usable
                    ? '\nno live reply from the lookup command'
                    : '\nlive lookup is off in config (alts.lookupCommand)',
                color: 'dark_gray'
            });
            ctx.reply(parts);
            return;
        }

        parts.push({ text: `\n${sourceName(live)}`, color: 'gold' });
        shown.forEach(([key, label, color], index) => {
            parts.push({ text: index ? '  ' : ' ', color: 'dark_gray' });
            parts.push({ text: `${label}: `, color: 'dark_gray' });
            parts.push({ text: fields[key], color: valueColour(key, fields[key], color) });
        });

        ctx.reply(parts);
    }
};

// The command the fields came from, as it is shown: "whois {player}" is whois.
function sourceName(live) {
    const command = String(live?.source || '').trim().replace(/^\/+/, '').split(/\s+/)[0];
    return command || 'live';
}

// A few fields read better when their value decides the colour.
function valueColour(key, value, fallback) {
    const text = String(value || '').toLowerCase();
    if (key === 'op' || key === 'god' || key === 'jail' || key === 'muted' || key === 'afk') {
        if (text === 'true' || text.startsWith('true')) return 'red';
        if (text === 'false' || text.startsWith('false')) return 'green';
    }
    if (key === 'whitelist') return text.includes('true') ? 'green' : 'dark_gray';
    return fallback;
}

