'use strict';

const { LEVEL, levelName } = require('../permissions');

module.exports = {
    name: 'core',
    description: 'Run a command through the core command blocks, or manage it',
    usage: 'core [status|reset|refill|<command>]',
    level: 'admin',

    async execute(ctx) {
        const core = ctx.bot.core;
        if (!core) {
            ctx.reply('Core is not loaded.');
            return;
        }

        const first = String(ctx.args[0] || 'status').toLowerCase();

        if (first === 'status' || !ctx.argString) {
            const parts = core.statusParts();
            const token = core.origin.x !== null
                ? ctx.clickToken('core-refill', async clicker => {
                    const level = ctx.permissions.levelFor({ name: clicker.name, uuid: clicker.uuid });
                    if (level < LEVEL.ADMIN) {
                        ctx.bot.registry.reply(ctx.bot, clicker.name, 'Only admins can refill the core.');
                        return;
                    }
                    core.refill('button');
                    ctx.bot.registry.reply(ctx.bot, clicker.name, 'Refilling the core.');
                })
                : null;

            if (token) {
                parts.push(
                    { text: '  [' },
                    {
                        text: 'refill',
                        color: 'aqua',
                        click: { action: 'run_command', value: token },
                        hover: { text: 'Rebuild the core now' }
                    },
                    { text: ']' }
                );
            }
            ctx.reply(parts);
            return;
        }

        if (first === 'reset') {
            const placed = core.reset(ctx.bot.position);
            ctx.reply(placed ? core.statusParts() : 'No position seen yet; move the bot first.');
            return;
        }

        if (first === 'refill') {
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
