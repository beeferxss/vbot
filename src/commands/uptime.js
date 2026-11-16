'use strict';

function formatDuration(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (secs || !parts.length) parts.push(`${secs}s`);
    return parts.join(' ');
}

module.exports = {
    name: 'uptime',
    description: 'Show how long this bot has been connected',
    usage: 'uptime',
    level: 'public',

    async execute(ctx) {
        const since = ctx.bot.connectedAt;
        if (!since) return ctx.reply(`${ctx.bot.id} is not connected; uptime is unavailable.`);
        ctx.reply(`${ctx.bot.id} has been connected for ${formatDuration((Date.now() - since) / 1000)}.`);
    }
};
