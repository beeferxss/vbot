'use strict';

const {
    chestPosition,
    parseChestArgs,
    clampDoublings,
    buildCrashChest,
    SEED_LENGTH,
    BYTES_PER_CHAR
} = require('../crash');

module.exports = {
    name: 'crashchest',
    description: 'Build the crash chest that servercrash scoreboard points at (admin only)',
    usage: 'crashchest [x y z] [doublings]',
    level: 'admin',

    async execute(ctx) {
        const core = ctx.bot.core;
        if (!core || !core.ready) return ctx.reply('Core is not ready.');

        const parsed = parseChestArgs(ctx.args);
        if (!parsed) {
            return ctx.reply(`Usage: ${ctx.prefix}crashchest [x y z] [doublings]`);
        }

        const doublings = clampDoublings(parsed.rest[0]);
        const position = parsed.position || chestPosition(ctx.bot);
        if (!position) return ctx.reply('No position yet: the bot has not seen a spawn packet.');

        const built = await buildCrashChest(ctx, position, doublings);
        if (!built.ok) return ctx.reply(built.error);

        return ctx.reply(
            `Crash chest at ${built.at}: ${SEED_LENGTH.toLocaleString()} chars x2^${doublings} = ` +
            `${built.chars.toLocaleString()} chars (~${(built.chars * BYTES_PER_CHAR).toLocaleString()} bytes).`
        );
    }
};
