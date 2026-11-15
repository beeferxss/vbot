'use strict';

const { levelName } = require('../permissions');

module.exports = {
    name: 'help',
    aliases: ['commands'],
    description: 'List the commands you can use',
    usage: 'help [command]',
    level: 'public',

    async execute(ctx) {
        const registry = ctx.bot.registry;

        if (ctx.args.length) {
            const command = registry.find(ctx.args[0]);
            if (!command || command.level > ctx.level) {
                ctx.reply(`No command "${ctx.args[0]}" available to you.`);
                return;
            }
            const usage = command.usage ? `${ctx.prefix}${command.usage}` : `${ctx.prefix}${command.name}`;
            ctx.reply(`${command.name} — ${command.description || 'no description'} | usage: ${usage}`);
            return;
        }

        const available = registry.listFor(ctx.level);
        ctx.reply(
            `Commands for ${ctx.levelName} (${available.length}): ` +
            available.map(command => command.name).join(', ')
        );
    }
};
