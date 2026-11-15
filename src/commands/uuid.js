'use strict';

const { normalizeUuid, offlineUuid } = require('../minecraft/uuid');

module.exports = {
    name: 'uuid',
    description: 'Resolve a player name to its known and offline-mode UUIDs',
    usage: 'uuid [name]',
    level: 'public',

    async execute(ctx) {
        const name = ctx.args[0] || ctx.username;
        const player = ctx.store.getPlayer(name);
        const known = normalizeUuid(player?.uuid ?? null);
        const derived = offlineUuid(name);

        const parts = [`known: ${known || 'unknown'}`];
        parts.push(`offline: ${derived}`);

        if (known && derived && known !== derived) {
            parts.push('(online-mode account: offline UUID differs)');
        }
        ctx.reply(`${name} — ${parts.join(' | ')}`);
    }
};
