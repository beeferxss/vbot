'use strict';

const { routeComponent, send } = require('../netchat');

function addressOf(bot) {
    return `${bot.server?.host || '?'}:${bot.server?.port || '?'}`;
}

module.exports = {
    name: 'serverchat',
    aliases: ['sc'],
    description: 'Send a message to one specific server',
    usage: 'serverchat <server> <message>',
    level: 'public',

    async execute(ctx) {
        const id = String(ctx.args[0] || '').toLowerCase();
        const message = ctx.args.slice(1).join(' ').trim();
        if (!id || !message) return ctx.reply(`Usage: ${ctx.prefix}serverchat <server> <message>`);

        const target = ctx.bots.get(id);
        if (!target) {
            const available = [...ctx.bots.keys()].join(', ');
            return ctx.reply(`No server "${id}". Available: ${available || 'none'}`);
        }
        if (target.id === ctx.bot.id) {
            return ctx.reply('That is this server; use netmsg for all servers or pick another one.');
        }

        const component = routeComponent({
            from: ctx.username,
            fromAddress: addressOf(ctx.bot),
            toAddress: addressOf(target),
            message
        });

        if (!send(target, component)) return ctx.reply(`Server "${id}" could not take the message.`);
        if (!send(ctx.bot, component)) { /* the target already has it */ }
    }
};
