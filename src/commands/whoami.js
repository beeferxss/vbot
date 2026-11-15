'use strict';

module.exports = {
    name: 'whoami',
    aliases: ['rank'],
    description: 'Show your rank and first seen date',
    level: 'public',

    async execute(ctx) {
        const player = ctx.store.getPlayer(ctx.username);
        const seen = player ? new Date(player.first_seen).toISOString().slice(0, 10) : 'unknown';
        const messages = player ? player.messages : 0;
        ctx.reply(`You are ${ctx.levelName} (${ctx.username}), first seen ${seen}, ${messages} message(s) logged.`);
    }
};
