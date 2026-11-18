'use strict';

const { levelName } = require('../permissions');

module.exports = {
    name: 'core',
    description: 'Run a command through the core command blocks, or manage it',
    usage: 'core [status|reset|refill|<command>]',
    level: 'public',

    async execute(ctx) {
        const core = ctx.bot.core;
        if (!core) {
            ctx.reply('Core is not loaded.');
            return;
        }

        const first = String(ctx.args[0] || 'status').toLowerCase();

        if (first === 'status' || !ctx.argString) {
            ctx.reply(core.miniStatusParts());
            return;
        }

        if (first === 'reset') {
            const placed = core.reset(ctx.bot.position);
            ctx.reply(placed ? core.statusParts() : 'No position seen yet; move the bot first.');
            return;
        }

        if (first === 'refill') {
            // Forced, so it goes out even while another refill is settling. It
            // still goes through the bot's own command blocks, never chat.
            const started = core.refill('command');
            ctx.reply(started ? 'Refilling the core.' : 'Core refill is disabled or the area is not placed.');
            return;
        }

        const cell = core.run(ctx.argString);
        if (!cell) {
            ctx.reply('Could not write to the core.');
            return;
        }
        ctx.logger.debug(`core ran "${ctx.argString}" at ${cell.x} ${cell.y} ${cell.z}`);
        ctx.reply(`Ran in core block ${cell.x} ${cell.y} ${cell.z} as ${levelName(ctx.level)}.`);
    }
};
