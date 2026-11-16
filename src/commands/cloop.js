'use strict';

module.exports = {
    name: 'cloop',
    aliases: ['commandloop'],
    description: 'Persistent command loops, run through the core',
    usage: 'cloop <add|remove|list|clear> ...',
    level: 'trusted',

    async execute(ctx) {
        const cloops = ctx.bot.cloops;
        if (!cloops) return ctx.reply('Command loops are not loaded.');

        const sub = String(ctx.args[0] || '').toLowerCase();
        const rest = ctx.args.slice(1);

        if (sub === 'add') {
            if (rest.length < 2) return ctx.reply(`Usage: ${ctx.prefix}cloop add <ms> <command>`);
            const ms = Number(rest[0]);
            if (!Number.isFinite(ms) || ms < cloops.minIntervalMs) {
                return ctx.reply(`The interval has to be at least ${cloops.minIntervalMs}ms.`);
            }
            const entry = cloops.add(ms, rest.slice(1).join(' '));
            if (!entry) return ctx.reply('Could not add that loop.');
            return ctx.reply(`Loop ${entry.id}: "${entry.command}" every ${entry.interval}ms.`);
        }

        if (sub === 'remove' || sub === 'del' || sub === 'delete') {
            const id = Number(rest[0]);
            if (!Number.isFinite(id)) return ctx.reply(`Usage: ${ctx.prefix}cloop remove <id>`);
            const removed = cloops.remove(id);
            return ctx.reply(removed ? `Removed loop ${id}.` : `There is no loop ${id}.`);
        }

        if (sub === 'list') {
            const list = cloops.list();
            if (!list.length) return ctx.reply('No command loops.');
            const lines = list.map(item => `${item.id}: every ${item.interval}ms -> ${item.command}`);
            return ctx.reply(`Command loops (${list.length})\n${lines.join('\n')}`);
        }

        if (sub === 'clear') {
            const had = cloops.clear();
            return ctx.reply(had ? `Cleared ${had} command loop(s).` : 'There were no command loops.');
        }

        return ctx.reply(`Usage: ${ctx.prefix}cloop <add|remove|list|clear> ...`);
    }
};
