'use strict';

module.exports = {
    name: 'ping',
    aliases: ['pong'],
    description: 'Show the bot\'s connection latency',
    level: 'public',

    async execute(ctx) {
        const latency = ctx.client?.latency;
        const measured = Number.isFinite(latency) && latency > 0 ? `${Math.round(latency)}ms` : 'unknown';
        const uptime = formatUptime(process.uptime());
        ctx.reply(`pong — ${measured}, up ${uptime}`);
    }
};

function formatUptime(seconds) {
    const total = Math.floor(seconds);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours || days) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(' ');
}
