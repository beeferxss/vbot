'use strict';

module.exports = {
    name: 'whereami',
    aliases: ['location'],
    description: 'Show this bot, its server and its coordinates',
    usage: 'whereami',
    level: 'public',

    async execute(ctx) {
        const bot = ctx.bot;
        const position = bot.position;
        const coords = position
            ? `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`
            : 'position not seen yet';
        const address = `${bot.server?.host || '?'}:${bot.server?.port || '?'}`;
        ctx.reply(`${bot.id} (${address}) | ${coords}`);
    }
};
