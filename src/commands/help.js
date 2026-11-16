'use strict';

const { NAMES, levelName } = require('../permissions');

const RANK_COLOR = { public: 'gray', trusted: 'green', admin: 'red', owner: 'light_purple' };
const COMMAND_COLOR = 'aqua';
const LOCKED_COLOR = 'dark_gray';

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

// A command you cannot use is still listed, so everyone can see what the bot
// offers, but it is greyed out and not clickable.
function entry(prefix, level, command) {
    if (command.level <= level) return clickable(prefix, command);
    return {
        text: command.name,
        color: LOCKED_COLOR,
        hover: {
            text: `${usageOf(prefix, command)}\n${command.description || 'no description'}\nneeds ${levelName(command.level)}`
        }
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
            const usage = usageOf(ctx.prefix, command);
            const parts = [
                {
                    text: usage,
                    color: COMMAND_COLOR,
                    // Copy, not run: a usage line is not something to fire off.
                    click: { action: 'copy_to_clipboard', value: usage },
                    hover: { text: 'Click to copy this usage' }
                },
                { text: ' — ', color: 'dark_gray' },
                { text: command.description || 'no description', color: 'gray' },
                { text: ` [${levelName(command.level)}]`, color: RANK_COLOR[levelName(command.level)] }
            ];
            if (command.level > ctx.level) {
                parts.push({ text: ' you cannot use this', color: LOCKED_COLOR, italic: true });
            }
            ctx.reply(parts);
            return;
        }

        const all = registry.listAll();
        const parts = [
            { text: 'Commands', color: 'gold' },
            { text: ` (${all.length})`, color: 'dark_gray' }
        ];

        // Grouped by rank so everything is visible from any rank: an owner still
        // sees the public commands, and a public player sees what exists.
        for (const rank of NAMES) {
            const group = all.filter(command => levelName(command.level) === rank);
            if (!group.length) continue;

            parts.push({ text: `\n${rank}: `, color: RANK_COLOR[rank] });
            group.forEach((command, index) => {
                if (index) parts.push({ text: ' ', color: 'dark_gray' });
                parts.push(entry(ctx.prefix, ctx.level, command));
            });
        }

        ctx.reply(parts);
    }
};
