'use strict';

// Who is online, with a clickable UUID. Ported from the reference bot's list
// command: one page of eight, previous/next as clickable buttons.
//
// Clicks are suggestions here; the registry turns every suggestion into a real
// button, so clicking a page arrow runs the command instead of pasting it.

const PER_PAGE = 8;
const NAME_COLOURS = ['aqua', 'green', 'gold', 'light_purple', 'yellow'];

function playersOf(bot) {
    if (!(bot.online instanceof Map) || !bot.online.size) return [];
    return [...bot.online.values()]
        // An online-mode UUID can be unknown until the tab list says it; the
        // player is still online, so they are still listed.
        .filter(player => player && player.name)
        .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
    name: 'list',
    description: 'List online players with clickable UUIDs',
    usage: 'list [page]',
    level: 'public',
    aliases: ['players'],

    async execute(ctx) {
        const online = playersOf(ctx.bot);
        if (!online.length) {
            ctx.reply('No players online.');
            return;
        }

        const pages = Math.max(1, Math.ceil(online.length / PER_PAGE));
        const asked = Number.parseInt(ctx.args[0], 10);
        const page = Math.min(Math.max(Number.isFinite(asked) ? asked : 1, 1), pages);

        const start = (page - 1) * PER_PAGE;
        const shown = online.slice(start, start + PER_PAGE);

        const parts = [
            { text: 'Online ', color: 'gold' },
            { text: `(${online.length}`, color: 'gray' },
            { text: pages > 1 ? `, page ${page}/${pages})` : ')', color: 'gray' },
            { text: '\n' }
        ];

        shown.forEach((player, index) => {
            if (index > 0) parts.push({ text: '\n' });
            const uuid = player.uuid;
            parts.push({
                text: player.name,
                color: NAME_COLOURS[(start + index) % NAME_COLOURS.length],
                ...(uuid
                    ? {
                        hover: { text: 'Click to copy UUID' },
                        click: { action: 'copy_to_clipboard', value: uuid }
                    }
                    : {})
            });
            parts.push({ text: ' - ', color: 'dark_gray' });
            parts.push(uuid
                ? {
                    text: uuid,
                    color: 'blue',
                    hover: { text: 'Click to copy UUID' },
                    click: { action: 'copy_to_clipboard', value: uuid }
                }
                : { text: 'uuid unknown', color: 'dark_gray' });
        });

        if (pages > 1) {
            parts.push({ text: '\n' });
            if (page > 1) {
                parts.push({
                    text: '◀ ',
                    color: 'aqua',
                    hover: { text: 'Previous page' },
                    click: { action: 'suggest_command', value: `${ctx.prefix}list ${page - 1}` }
                });
            }
            parts.push({ text: `page ${page}/${pages}`, color: 'gray' });
            if (page < pages) {
                parts.push({
                    text: ' ▶',
                    color: 'aqua',
                    hover: { text: 'Next page' },
                    click: { action: 'suggest_command', value: `${ctx.prefix}list ${page + 1}` }
                });
            }
        }

        ctx.reply(parts);
    }
};
