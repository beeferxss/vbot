'use strict';

const { routeComponent, send } = require('../netchat');

function addressOf(bot) {
    return `${bot.server?.host || '?'}:${bot.server?.port || '?'}`;
}

module.exports = {
    name: 'netmsg',
    aliases: ['nm'],
    description: 'Send a message to every connected server',
    usage: 'netmsg <message>',
    level: 'public',

    async execute(ctx) {
        const message = ctx.argString.trim();
        if (!message) return ctx.reply(`Usage: ${ctx.prefix}netmsg <message>`);

        const from = ctx.username;
        const fromAddress = addressOf(ctx.bot);
        const component = routeComponent({ from, fromAddress, message });

        let sent = 0;
        for (const bot of ctx.bots.values()) {
            if (send(bot, component)) sent += 1;
        }

        if (!sent) ctx.reply('No server could take the message.');
    }
};
