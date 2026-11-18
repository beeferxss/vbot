'use strict';

// `botcspy`: read what other bots are running. It asks the server about every
// block in a box and prints the command of each command block it finds - which is
// how another bot's core shows itself. The box is two corners, as in fill, with ~
// for an offset from the bot; leaving them out sweeps where this bot stands.

const { MAX_CELLS } = require('../botcspy');

const MAX_LINES = 12;
const AXES = ['x', 'y', 'z'];

function place(entry) {
    return `${entry.cell.x} ${entry.cell.y} ${entry.cell.z}`;
}

function boxText(from, to) {
    return `${from.x} ${from.y} ${from.z} to ${to.x} ${to.y} ${to.z}`;
}

// A corner the way fill takes one: a whole number, or ~ and ~N for an offset
// from where the bot stands.
function corner(token, base) {
    const text = String(token ?? '').trim();
    if (!text) return null;

    if (text[0] === '~') {
        const offset = text.length > 1 ? Number(text.slice(1)) : 0;
        if (!Number.isFinite(offset) || !Number.isFinite(base)) return null;
        return Math.floor(base + offset);
    }

    const value = Number(text);
    return Number.isFinite(value) ? Math.floor(value) : null;
}

function lines(found) {
    const parts = [];
    for (const entry of found.slice(0, MAX_LINES)) {
        parts.push({ text: '\n' });
        parts.push({ text: `${place(entry)} `, color: 'dark_gray' });
        if (entry.auto) parts.push({ text: 'auto ', color: 'green' });
        parts.push({ text: entry.command, color: 'white' });
        if (entry.count > 1) parts.push({ text: ` (${entry.count} blocks)`, color: 'gray' });
    }
    if (found.length > MAX_LINES) {
        parts.push({ text: `\n…and ${found.length - MAX_LINES} more in the console log`, color: 'gray' });
    }
    return parts;
}

module.exports = {
    name: 'botcspy',
    aliases: ['cspy'],
    description: 'Scan for command blocks and read the commands other bots run in them',
    usage: 'botcspy [x1 y1 z1 x2 y2 z2] | botcspy watch [x1 y1 z1 x2 y2 z2] | botcspy stop',
    level: 'trusted',

    async execute(ctx) {
        const spy = ctx.bot.cspy;
        if (!spy) {
            ctx.reply('The core spy is not loaded.');
            return;
        }

        const first = String(ctx.args[0] || '').toLowerCase();
        if (first === 'stop') {
            ctx.reply(spy.stop('command') ? 'Core spy stopped.' : 'The core spy was not running.');
            return;
        }

        if (first === 'status') {
            ctx.reply(`Core spy: ${spy.watching ? 'watching' : 'idle'}.`);
            return;
        }

        const watching = first === 'watch';
        const rest = watching ? ctx.args.slice(1) : ctx.args;

        let from = null;
        let to = null;
        if (rest.length) {
            if (rest.length !== 6) {
                ctx.reply([
                    { text: 'Give the box as two corners, like fill: ', color: 'gray' },
                    { text: 'x1 y1 z1 x2 y2 z2', color: 'white' },
                    { text: '. Leave it out for a box around the bot.', color: 'gray' }
                ]);
                return;
            }

            const at = ctx.bot.position || {};
            const base = [at.x, at.y, at.z];
            const values = rest.map((token, index) => corner(token, base[index % AXES.length]));
            if (values.some(value => value === null)) {
                ctx.reply('Give whole numbers, or ~ for where the bot stands: e.g. ~ ~ ~ ~15 ~ ~15.');
                return;
            }

            from = { x: values[0], y: values[1], z: values[2] };
            to = { x: values[3], y: values[4], z: values[5] };

            // Counted here so a mistyped corner is refused before the sweep
            // starts, and so watch mode does not start on a box it cannot walk.
            const size = AXES.reduce(
                (total, axis) => total * (Math.abs(to[axis] - from[axis]) + 1),
                1
            );
            if (size > MAX_CELLS) {
                ctx.reply(`That box is ${size} blocks; keep it to ${MAX_CELLS} or fewer.`);
                return;
            }
        }

        if (watching) {
            const seen = new Set();
            const started = spy.watch({
                from,
                to,
                onScan: result => {
                    for (const entry of result.found) {
                        if (seen.has(entry.command)) continue;
                        seen.add(entry.command);
                        ctx.logger.info(
                            `core spy: ${place(entry)} ${entry.auto ? '(auto) ' : ''}runs ${entry.command}`
                        );
                    }
                }
            });
            if (!started) {
                ctx.reply('The core spy is already watching. Try botcspy stop first.');
                return;
            }
            ctx.reply([
                { text: 'core spy ', color: 'gold' },
                {
                    text: `watching ${from && to ? boxText(from, to) : 'a box around the bot'}`,
                    color: 'white'
                },
                { text: ' - commands run in it go to the console log. ', color: 'gray' },
                { text: 'botcspy stop', color: 'aqua' },
                { text: ' ends it.', color: 'gray' }
            ]);
            return;
        }

        const result = await spy.scan({ from, to });
        if (!result.ok) {
            if (result.reason === 'too-big') {
                ctx.reply(`That box is ${result.cells} blocks; keep it to ${MAX_CELLS} or fewer.`);
                return;
            }
            const why = {
                busy: 'a sweep is already running',
                'no-position': 'no position seen yet; move the bot first',
                'bad-box': 'that box is not made of whole numbers',
                'no-write': 'this bot cannot talk to its server'
            }[result.reason] || result.reason;
            ctx.reply(`Core spy could not run: ${why}.`);
            return;
        }

        if (!result.answered) {
            ctx.reply([
                { text: 'core spy ', color: 'gold' },
                { text: `asked about ${result.cells} block(s) and none were answered. `, color: 'white' },
                { text: 'Block queries need the bot to be opped.', color: 'gray' }
            ]);
            return;
        }

        if (!result.found.length) {
            ctx.reply([
                { text: 'core spy ', color: 'gold' },
                { text: `no command blocks in ${boxText(result.from, result.to)} `, color: 'white' },
                { text: `(${result.answered}/${result.cells} answered)`, color: 'gray' }
            ]);
            return;
        }

        ctx.reply([
            { text: 'core spy ', color: 'gold' },
            { text: `${result.found.length} command(s) found`, color: 'white' },
            { text: `, ${result.answered}/${result.cells} blocks answered`, color: 'gray' },
            ...lines(result.found)
        ]);
        for (const entry of result.found.slice(MAX_LINES)) {
            ctx.logger.info(`core spy: ${place(entry)} runs ${entry.command}`);
        }
    }
};
