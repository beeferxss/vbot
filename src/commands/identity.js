'use strict';

const { normalizeUuid } = require('../minecraft/uuid');
const { levelName } = require('../permissions');

module.exports = {
    name: 'identity',
    aliases: ['whois'],
    description: 'Inspect everything the bot knows about a player',
    usage: 'identity [name]',
    level: 'trusted',

    async execute(ctx) {
        const name = ctx.args[0] || ctx.username;
        const player = ctx.store.getPlayer(name);

        const stored = normalizeUuid(player?.uuid);
        const uuid = stored || (typeof ctx.bot.uuidFor === 'function' ? ctx.bot.uuidFor(name) : null);
        let source = 'unknown';
        if (stored) source = 'player list';
        else if (uuid) source = 'derived (offline)';

        const rank = ctx.permissions.levelFor({ name, uuid });
        const lastSeen = player
            ? new Date(player.last_seen).toISOString().slice(0, 16).replace('T', ' ')
            : 'never';

        ctx.reply(`${name} — ${uuid || 'no uuid'} (${source}), rank ${levelName(rank)}, last seen ${lastSeen}`);
    }
};
