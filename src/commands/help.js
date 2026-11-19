'use strict';

const { NAMES, levelName } = require('../permissions');

const RANK_COLOR = { public: 'gray', trusted: 'green', admin: 'red', owner: 'light_purple' };
const COMMAND_COLOR = 'aqua';

function usageOf(prefix, command) {
    return `${prefix}${command.usage || command.name}`;
}

// Clicking a command name opens its help instead of running it: nothing fires
// by accident, and the entry is a real button (the registry turns every
// suggestion into one).
function clickable(prefix, command) {
    return {
        text: command.name,
        color: COMMAND_COLOR,
        click: { action: 'suggest_command', value: `${prefix}help ${command.name}` },
        hover: { text: `${usageOf(prefix, command)}\n${command.description || 'no description'}\nclick to open its help` }
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
            if (!command) {
                ctx.reply(`No command "${ctx.args[0]}".`);
                return;
            }
            // A command above the asker's rank is not theirs to read: say what
            // it needs and stop, rather than showing them what it does.
            if (command.level > ctx.level) {
                ctx.reply(`${command.name} needs ${levelName(command.level)}; you are ${ctx.levelName}.`);
                return;
            }

            const usage = usageOf(ctx.prefix, command);
            // Suggest the command itself, ready to type, instead of copying the
            // usage line with its placeholders in it.
            const suggest = `${ctx.prefix}${command.name}`;
            ctx.reply([
                {
                    text: usage,
                    color: COMMAND_COLOR,
                    click: { action: 'suggest_command', value: suggest, noToken: true },
                    hover: { text: 'Click to suggest this command' }
                },
                { text: ' — ', color: 'dark_gray' },
                { text: command.description || 'no description', color: 'gray' },
                { text: ` [${levelName(command.level)}]`, color: RANK_COLOR[levelName(command.level)] }
            ]);
            return;
        }

        // Only what the asker can actually run: their rank and the ones below
        // it. A rank above theirs is not listed at all.
        const all = registry.listFor(ctx.level);
        const parts = [
            { text: 'Commands', color: 'gold' },
            { text: ` (${all.length})`, color: 'dark_gray' }
        ];

        for (const rank of NAMES) {
            const group = all.filter(command => levelName(command.level) === rank);
            if (!group.length) continue;

            parts.push({ text: `\n${rank}: `, color: RANK_COLOR[rank] });
            group.forEach((command, index) => {
                if (index) parts.push({ text: ' ', color: 'dark_gray' });
                parts.push(clickable(ctx.prefix, command));
            });
        }

        ctx.reply(parts);
    }
};
