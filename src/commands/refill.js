'use strict';

// Spam refills: the same fill, written into a core block again and again, so a
// wrecked area is back in a second or two instead of waiting for the watchdog.
//
// Separate from "core refill", which sends one fill as chat on purpose - this
// one is for speed, so it only uses blocks and never touches chat.

const DEFAULT_SECONDS = 10;
const MAX_SECONDS = 120;

module.exports = {
    name: 'refill',
    aliases: ['spamrefill'],
    description: 'Refill the core in a fast burst through its command blocks',
    usage: 'refill [seconds|stop|status]',
    level: 'admin',

    async execute(ctx) {
        const core = ctx.bot.core;
        if (!core) {
            ctx.reply('Core is not loaded.');
            return;
        }

        const first = String(ctx.args[0] || '').toLowerCase();

        if (first === 'stop') {
            const stopped = core.stopSpam('stopped');
            ctx.reply(stopped ? 'Spam refill stopped.' : 'No spam refill is running.');
            return;
        }

        if (first === 'status') {
            const status = core.spamStatus();
            ctx.reply(status.running
                ? `Spam refill: every ${status.intervalMs}ms, ${status.count} fill(s), ` +
                  `${Math.ceil(status.leftMs / 1000)}s left.`
                : `Spam refill is not running (would use every ${status.intervalMs}ms).`);
            return;
        }

        const asked = Number.parseInt(first, 10);
        const seconds = Math.min(
            Math.max(Number.isFinite(asked) ? asked : DEFAULT_SECONDS, 1),
            MAX_SECONDS
        );

        const intervalMs = Number(ctx.config?.core?.refill?.spamMs) || undefined;
        const started = core.startSpam({ intervalMs, durationMs: seconds * 1000 });
        if (!started) {
            ctx.reply(core.spamStatus().running
                ? 'Spam refill is already running; use refill stop first.'
                : 'Spam refill needs a placed core and refills enabled.');
            return;
        }

        const every = core.spamStatus().intervalMs;
        ctx.reply(`Spam refilling for ${seconds}s, every ${every}ms.`);
    }
};
