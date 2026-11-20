'use strict';

const { cleanName } = require('../filter');

// One command per online player: `$name` and `$uuid` are replaced per player,
// and `$regex:pattern` narrows who the command runs on. The bot itself is never
// a target: a command aimed at every player should not also hit the one running
// the core. Without any placeholder the command runs once, like `cb`.
const MAX_PLAYERS = 100;

module.exports = {
    name: 'supercb',
    aliases: ['scb'],
    description: 'Run one command per online player with $name, $uuid or $regex:pattern placeholders',
    usage: 'supercb <command with $name|$uuid|$regex:pattern>',
    level: 'trusted',

    async execute(ctx) {
        const bot = ctx.bot;
        let template = String(ctx.argString ?? '').trim().replace(/^\/+/, '');
        if (!template) return ctx.reply(`Usage: ${ctx.prefix}${this.usage}`);

        const online = bot.online instanceof Map ? [...bot.online.values()] : [];
        const self = cleanName(bot.server?.username);
        let players = online.filter(player => player?.name && cleanName(player.name) !== self);
        if (!players.length) return ctx.reply('Nobody else is online.');

        // The filter is taken out of the command before anything is sent.
        const filter = /\$regex:(\S+)/i.exec(template);
        if (filter) {
            let pattern;
            try {
                pattern = new RegExp(filter[1], 'i');
            } catch {
                return ctx.reply(`Invalid regex: ${filter[1]}`);
            }
            template = template.replace(/\$regex:\S+/i, '').replace(/\s+/g, ' ').trim();
            players = players.filter(player => pattern.test(player.name));
            if (!players.length) return ctx.reply(`Nobody online matches $regex:${filter[1]}.`);
            if (!template) return ctx.reply(`Usage: ${ctx.prefix}${this.usage}`);
        }

        const usesName = /\$name\b/i.test(template);
        const usesUuid = /\$uuid\b/i.test(template);

        // A bare command with a filter still needs the player named, or every
        // copy would be identical; naming them is what a filtered run means.
        if (!usesName && !usesUuid) {
            if (!filter) {
                return ctx.reply(ctx.run(template)
                    ? 'Sent through the core.'
                    : 'The core could not take that command right now.');
            }
            template = `${template} $name`;
        }

        let sent = 0;
        for (const player of players.slice(0, MAX_PLAYERS)) {
            const name = player.name;
            const uuid = player.uuid || (typeof bot.uuidFor === 'function' ? bot.uuidFor(name) : null) || 'unknown';
            const command = template.replace(/\$name\b/gi, name).replace(/\$uuid\b/gi, uuid);
            if (ctx.run(command)) sent += 1;
        }

        if (!sent) return ctx.reply('The core could not take the command.');
        return ctx.reply(`Ran on ${sent}/${players.length} player(s): ${template}`);
    }
};
