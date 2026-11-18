'use strict';

// `botcspy`: read what other bots are running. It asks the server about every
// block in a box and prints the command of each command block it finds - which is
// how another bot's core shows itself. The box defaults to where this bot stands,
// which is where a core usually is too.

const MAX_LINES = 12;

function place(entry) {
    return `${entry.cell.x} ${entry.cell.y} ${entry.cell.z}`;
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
    usage: 'botcspy [radius [x y z]] | botcspy watch [radius] | botcspy stop',
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

        const watching = first === 'watch';
        const rest = watching ? ctx.args.slice(1) : ctx.args;
        if (first === 'status') {
            ctx.reply(`Core spy: ${spy.watching ? 'watching' : 'idle'}.`);
            return;
        }

        const radius = rest.length ? Number(rest[0]) : 8;
        if (!Number.isFinite(radius) || radius < 0 || radius > 64) {
            ctx.reply('Give a radius between 0 and 64.');
            return;
        }

        let origin = null;
        if (rest.length >= 4) {
            const [x, y, z] = rest.slice(1, 4).map(Number);
            if (![x, y, z].every(Number.isFinite)) {
                ctx.reply('Give the centre as x y z, or leave it out for where the bot stands.');
                return;
            }
            origin = { x, y, z };
        }

        if (watching) {
            const seen = new Set();
            const started = spy.watch({
                origin,
                radius,
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
                { text: `watching r${radius}`, color: 'white' },
                { text: ' - commands run in it go to the console log. ', color: 'gray' },
                { text: 'botcspy stop', color: 'aqua' },
                { text: ' ends it.', color: 'gray' }
            ]);
            return;
        }

        const result = await spy.scan({ origin, radius });
        if (!result.ok) {
            const why = {
                busy: 'a sweep is already running',
                'no-position': 'no position seen yet; move the bot first',
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
                { text: `no command blocks in r${radius} of ${place({ cell: result.origin })} `, color: 'white' },
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
