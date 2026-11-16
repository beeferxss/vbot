'use strict';

function timeAgo(ms) {
    const diff = Math.max(0, Date.now() - ms);
    const units = [
        ['year', 31536000000],
        ['month', 2592000000],
        ['day', 86400000],
        ['hour', 3600000],
        ['minute', 60000],
        ['second', 1000]
    ];
    const parts = [];
    let rest = diff;
    for (const [label, size] of units) {
        const count = Math.floor(rest / size);
        if (count > 0) {
            parts.push(`${count} ${label}${count === 1 ? '' : 's'}`);
            rest -= count * size;
        }
        if (parts.length === 2) break;
    }
    return parts.length ? `${parts.join(' ')} ago` : 'just now';
}

module.exports = {
    name: 'seen',
    description: 'Show when a player was last seen',
    usage: 'seen <player>',
    level: 'public',

    async execute(ctx) {
        const name = ctx.argString.trim();
        if (!name) return ctx.reply(`Usage: ${ctx.prefix}seen <player>`);

        const key = name.toLowerCase();
        const online = ctx.bot.online instanceof Map ? ctx.bot.online.get(key) : null;
        if (online) return ctx.reply(`${online.name} is online on ${ctx.bot.id}.`);

        const player = ctx.store.getPlayer(name);
        if (player?.last_seen) {
            const date = new Date(player.last_seen).toISOString().replace('T', ' ').slice(0, 16);
            return ctx.reply(`${player.name} was last seen ${timeAgo(player.last_seen)} (${date} UTC).`);
        }

        return ctx.reply(`No record of ${name}.`);
    }
};
