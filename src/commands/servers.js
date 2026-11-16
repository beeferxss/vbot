'use strict';

function onlinePlayers(bot) {
    const names = [];
    if (bot.online instanceof Map) {
        for (const player of bot.online.values()) {
            if (player?.name) names.push(player.name);
        }
    }
    return names.sort((a, b) => a.localeCompare(b));
}

module.exports = {
    name: 'servers',
    aliases: ['ss'],
    description: 'List servers with their online player count (hover for names)',
    usage: 'servers',
    level: 'public',

    async execute(ctx) {
        const bots = ctx.bots;
        if (!bots || !bots.size) return ctx.reply('No servers configured.');

        const entries = [...bots.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const parts = [{ text: `Servers (${entries.length})`, color: 'gold' }];

        for (const bot of entries) {
            const online = bot.state === 'ready';
            const players = online ? onlinePlayers(bot) : [];
            const address = `${bot.server?.host || '?'}:${bot.server?.port || '?'}`;
            const names = players.length
                ? players.slice(0, 20).join(', ') + (players.length > 20 ? ` (+${players.length - 20} more)` : '')
                : '(none)';
            const hover = `${address}\n${online ? 'online' : 'offline'}\nplayers online (${players.length}):\n${names}`;

            parts.push({
                text: `\n${bot.id}`,
                color: online ? 'aqua' : 'dark_gray',
                click: { action: 'copy_to_clipboard', value: address },
                hover: { text: hover }
            });
            parts.push({ text: ' - ', color: 'dark_gray' });
            parts.push({
                text: `${players.length} player${players.length === 1 ? '' : 's'} online`,
                color: online ? 'green' : 'red',
                hover: { text: hover }
            });
        }

        ctx.reply(parts);
    }
};
