'use strict';

const { NAMES, levelName } = require('../permissions');

const RANK_COLOR = { public: 'gray', trusted: 'green', admin: 'red', owner: 'light_purple' };
const COMMAND_COLOR = 'aqua';
const LOCKED_COLOR = 'dark_gray';

function usageOf(prefix, command) {
    return `${prefix}${command.usage || command.name}`;
}

// Clicking a command puts it in the chat bar ready to edit; it does not run
// anything by itself, since the player still has to press enter.
function clickable(prefix, command) {
    return {
        text: command.name,
        color: COMMAND_COLOR,
        click: { action: 'suggest_command', value: `${prefix}${command.name} ` },
        hover: { text: `${usageOf(prefix, command)}\n${command.description || 'no description'}` }
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
                    click: { action: 'suggest_command', value: `${usage} ` },
                    hover: { text: 'Click to put this in chat' }
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
            { text: 'Commands', color: 'gold', bold: true },
            { text: ` (${all.length})`, color: 'dark_gray' }
        ];

        // Grouped by rank so everything is visible from any rank: an owner still
        // sees the public commands, and a public player sees what exists.
        for (const rank of NAMES) {
            const group = all.filter(command => levelName(command.level) === rank);
            if (!group.length) continue;

            parts.push({ text: `\n${rank}: `, color: RANK_COLOR[rank], bold: true });
            group.forEach((command, index) => {
                if (index) parts.push({ text: ' ', color: 'dark_gray' });
                parts.push(entry(ctx.prefix, ctx.level, command));
            });
        }

        ctx.reply(parts);
    }
};
