'use strict';

const { levelName } = require('../permissions');

const RANK_COLOR = { public: 'gray', trusted: 'green', admin: 'red', owner: 'light_purple' };
const COMMAND_COLOR = 'aqua';

// Clicking a command puts it in the chat bar ready to edit; it does not run
// anything by itself, since the player still has to press enter.
function suggestion(prefix, name) {
    return {
        text: name,
        color: COMMAND_COLOR,
        clickEvent: { action: 'suggest_command', value: `${prefix}${name} ` }
    };
}

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
            const usage = `${ctx.prefix}${command.usage || command.name}`;
            ctx.reply([
                { text: usage, color: COMMAND_COLOR, clickEvent: { action: 'suggest_command', value: `${usage} ` } },
                { text: ' — ', color: 'dark_gray' },
                { text: command.description || 'no description', color: 'gray' },
                { text: ` [${levelName(command.level)}]`, color: RANK_COLOR[levelName(command.level)] }
            ]);
            return;
        }

        const available = registry.listFor(ctx.level);
        const parts = [
            { text: 'Commands', color: 'gold', bold: true },
            { text: ` for ${ctx.levelName}`, color: 'yellow' },
            { text: ` (${available.length})\n`, color: 'dark_gray' }
        ];

        available.forEach((command, index) => {
            if (index) parts.push({ text: ', ', color: 'dark_gray' });
            parts.push(suggestion(ctx.prefix, command.name));
        });

        ctx.reply(parts);
    }
};
