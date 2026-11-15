'use strict';

const { shortUuid } = require('../minecraft/uuid');

module.exports = {
    name: 'whoami',
    aliases: ['rank'],
    description: 'Show your rank, UUID and first seen date',
    level: 'public',

    async execute(ctx) {
        const player = ctx.store.getPlayer(ctx.username);
        const seen = player ? new Date(player.first_seen).toISOString().slice(0, 10) : 'unknown';
        const messages = player ? player.messages : 0;
        const id = shortUuid(ctx.uuid) ? `#${shortUuid(ctx.uuid)}` : 'no uuid yet';
        ctx.reply(`You are ${ctx.levelName} (${ctx.username}, ${id}), first seen ${seen}, ${messages} message(s) logged.`);
    }
};
