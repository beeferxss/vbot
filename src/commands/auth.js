'use strict';

const { levelName } = require('../permissions');

module.exports = {
    name: 'auth',
    description: 'Authenticate with a rank key to unlock commands',
    usage: 'auth <key>',
    level: 'public',

    async execute(ctx) {
        if (!ctx.args.length) {
            ctx.reply(`Usage: ${ctx.prefix}auth <key>`);
            return;
        }

        const granted = ctx.permissions.redeem({
            name: ctx.username,
            uuid: ctx.store.getPlayer(ctx.username)?.uuid || null,
            key: ctx.args[0]
        });

        if (granted === null) {
            ctx.reply('Invalid key.');
            return;
        }
        ctx.reply(`Authenticated as ${levelName(granted)}.`);
    }
};
