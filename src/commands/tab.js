'use strict';

module.exports = {
    name: 'tab',
    aliases: ['complete'],
    description: 'Ask the server to tab-complete text',
    usage: 'tab <text>',
    level: 'trusted',

    async execute(ctx) {
        const text = ctx.argString;
        if (!text) return ctx.reply(`Usage: ${ctx.prefix}tab <text>`);
        if (typeof ctx.bot.tabComplete !== 'function') return ctx.reply('Tab completion is not available.');

        const matches = await ctx.bot.tabComplete(text);
        if (!matches.length) return ctx.reply('No completions.');
        const shown = matches.slice(0, 20);
        const rest = matches.length > shown.length ? ` (+${matches.length - shown.length} more)` : '';
        ctx.reply(`Completions (${matches.length}): ${shown.join(', ')}${rest}`);
    }
};
