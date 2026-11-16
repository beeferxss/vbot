'use strict';

module.exports = {
    name: 'cb',
    description: 'Run a command through the core (no output read back)',
    usage: 'cb <command>',
    level: 'public',

    async execute(ctx) {
        const core = ctx.bot.core;
        if (!core) return ctx.reply('Core is not loaded.');

        const command = ctx.argString.replace(/^\//, '').trim();
        if (!command) {
            return ctx.reply(core.origin?.x === null ? 'Core is not placed yet.' : `Core: ${core.status()}`);
        }

        return ctx.reply(core.run(command)
            ? 'Sent through the core.'
            : 'The core could not take that command right now.');
    }
};
