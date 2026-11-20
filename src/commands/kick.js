'use strict';

const { targetedKick } = require('../crash');
const { cleanName, isUuid, isIp } = require('../filter');

// One target, four shapes. `re:` or `/.../` is a regex over the online names;
// anything that parses as a UUID or an address is matched as one; the rest is a
// name. The command never asks the caller which kind they meant.
function parseTarget(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    if (text.startsWith('re:')) {
        try { return { kind: 'regex', value: new RegExp(text.slice(3), 'i') }; }
        catch { return null; }
    }
    if (text.length > 2 && text.startsWith('/') && text.endsWith('/')) {
        try { return { kind: 'regex', value: new RegExp(text.slice(1, -1), 'i') }; }
        catch { return null; }
    }
    if (isUuid(text)) return { kind: 'uuid', value: text.toLowerCase().replace(/-/g, '') };
    if (isIp(text)) return { kind: 'ip', value: text };
    return { kind: 'name', value: cleanName(text) };
}

function matches(bot, player, spec) {
    const name = cleanName(player?.name || player?.username);
    if (spec.kind === 'name') return name === spec.value;
    if (spec.kind === 'uuid') {
        return String(player?.uuid || '').toLowerCase().replace(/-/g, '') === spec.value;
    }
    if (spec.kind === 'ip') {
        const ips = bot.filter?.playerIps?.(player);
        if (!ips) return false;
        for (const ip of ips) if (String(ip).trim() === spec.value) return true;
        return false;
    }
    if (spec.kind === 'regex') return spec.value.test(name);
    return false;
}

module.exports = {
    name: 'kick',
    aliases: ['k'],
    description: 'Disconnect one online player by name, IP, UUID or regex (trusted, one shot)',
    usage: 'kick <player|ip|uuid|re:pattern|/pattern/>',
    level: 'trusted',

    async execute(ctx) {
        const raw = ctx.args.join(' ').trim();
        if (!raw) return ctx.reply(`Usage: ${ctx.prefix}${this.usage}`);

        const spec = parseTarget(raw);
        if (!spec) return ctx.reply(`Invalid regex: ${raw}`);

        const bot = ctx.bot;
        if (!bot?.core) return ctx.reply('Core is not ready.');

        const online = bot.online instanceof Map ? [...bot.online.values()] : [];
        const self = cleanName(bot.server?.username);
        const hits = online.filter(player =>
            player?.name &&
            cleanName(player.name) !== self &&
            matches(bot, player, spec));

        if (!hits.length) return ctx.reply(`Nobody online matches ${raw}.`);

        // One packet per match, once: the timeout is the server's job, and a
        // repeat here would only write into core blocks for a client that is
        // already gone.
        const sent = [];
        for (const player of hits) {
            if (ctx.run(targetedKick(player.name))) sent.push(player.name);
        }
        if (!sent.length) return ctx.reply('Core is not ready; nothing was sent.');
        return ctx.reply(`Kicked ${sent.length}: ${sent.join(', ')}`);
    }
};
