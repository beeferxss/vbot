'use strict';

// Spam refills: the same fill written into the core's own blocks over and over,
// as fast as the bot can send them. Switched on, it stays on until it is
// switched off, and it starts by itself when the bot logs in.
//
// Separate from "core refill", which sends one fill as chat on purpose - this one
// never touches chat.

module.exports = {
    name: 'refill',
    aliases: ['spamrefill'],
    description: 'Toggle continuous core refills through its blocks',
    usage: 'refill [on|off|status]',
    level: 'admin',

    async execute(ctx) {
        const core = ctx.bot.core;
        if (!core) {
            ctx.reply('Core is not loaded.');
            return;
        }

        const first = String(ctx.args[0] || 'on').toLowerCase();

        if (first === 'off' || first === 'stop') {
            const stopped = core.stopSpam('stopped');
            ctx.reply(stopped ? 'Refilling stopped.' : 'Refilling was not running.');
            return;
        }

        if (first === 'status') {
            const status = core.spamStatus();
            ctx.reply(status.running
                ? `Refilling every ${status.intervalMs}ms, ${status.count} fill(s) so far, until stopped.`
                : `Refilling is off (it would use every ${status.intervalMs}ms).`);
            return;
        }

        if (first !== 'on' && first !== 'start') {
            ctx.reply(`Usage: ${ctx.prefix}refill [on|off|status]`);
            return;
        }

        const intervalMs = Number(ctx.config?.core?.refill?.spamMs) || undefined;
        if (!core.startSpam({ intervalMs })) {
            ctx.reply(core.spamStatus().running
                ? 'Refilling is already on; use refill off first.'
                : 'Refilling needs a placed core and refills enabled.');
            return;
        }

        ctx.reply(`Refilling every ${core.spamStatus().intervalMs}ms until "${ctx.prefix}refill off".`);
    }
};
