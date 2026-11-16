'use strict';

const { levelName } = require('../permissions');

module.exports = {
    name: 'auth',
    aliases: ['validate', 'val'],
    description: 'Redeem a short-lived auth token to store your rank',
    usage: 'auth <token>',
    level: 'public',

    async execute(ctx) {
        if (!ctx.args.length) {
            ctx.reply(`Usage: ${ctx.prefix}auth <token> — generate one with: npm run token -- <rank>`);
            return;
        }

        const granted = ctx.tokens ? ctx.tokens.verify(ctx.args[0]) : null;
        if (granted === null) {
            ctx.reply('Invalid or expired token.');
            return;
        }

        ctx.permissions.grant(ctx.username, granted, 'token');
        ctx.reply(`Authenticated as ${levelName(granted)}.`);
    }
};
