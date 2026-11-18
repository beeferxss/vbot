'use strict';

// Ends the run. Everything the bot built goes first - the mini core's own blocks,
// which recreate core cells every tick, and then the core's area - so nothing is
// left running commands on the server. The process then exits with
// STOP_EXIT_CODE, which the workflow reads as "do not start another session";
// the data is checkpointed and pushed by the job afterwards.

const STOP_EXIT_CODE = 42;
const EXIT_DELAY_MS = 1500;

module.exports = {
    name: 'stop',
    description: 'Clear the cores and end the bot process',
    usage: 'stop',
    level: 'owner',

    async execute(ctx) {
        const core = ctx.bot.core;
        const cleared = [];
        if (core?.fillItem?.clear?.()) cleared.push('mini core');
        if (core?.clear?.()) cleared.push('core');

        ctx.reply(
            `Cleared ${cleared.length ? `the ${cleared.join(' and ')}` : 'nothing that was still standing'} ` +
            '- the process ends now; the data is pushed before the run finishes.'
        );

        // The reply and the fills need a moment to go out, and this timer is what
        // holds the process open until they have.
        setTimeout(() => process.exit(STOP_EXIT_CODE), EXIT_DELAY_MS);
    }
};

module.exports.STOP_EXIT_CODE = STOP_EXIT_CODE;
