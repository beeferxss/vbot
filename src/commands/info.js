'use strict';

const os = require('node:os');

function megabytes(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

module.exports = {
    name: 'info',
    description: 'Show bot and host system information',
    usage: 'info',
    level: 'trusted',

    async execute(ctx) {
        const bot = ctx.bot;
        const memory = process.memoryUsage();
        const load = os.loadavg().map(value => value.toFixed(2)).join('/');
        const ping = typeof bot.client?.latency === 'number' && bot.client.latency > 0
            ? `${Math.round(bot.client.latency)}ms`
            : 'n/a';
        const uptime = bot.connectedAt
            ? `${Math.round((Date.now() - bot.connectedAt) / 1000)}s connected`
            : 'not connected';
        const address = `${bot.server?.host || '?'}:${bot.server?.port || '?'}`;

        ctx.reply(
            `${bot.id} (${address}) | ${bot.state} | ${uptime} | ping ${ping}` +
            ` | bots ${ctx.bots?.size ?? 1}` +
            ` | ram ${megabytes(memory.rss)} (heap ${megabytes(memory.heapUsed)}/${megabytes(memory.heapTotal)})` +
            ` | cpu ${os.cpus().length} cores, load ${load}` +
            ` | process ${Math.round(process.uptime())}s`
        );
    }
};
