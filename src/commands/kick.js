'use strict';

const { KICK_INTERVAL_MS, TITLE_DEFAULT, targetedTitle } = require('../crash');
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

// Starts the title payload on this player and keeps it going four times a second
// until their name is no longer in `online`: they left, the client dropped, or
// the server timed them out. The loop lives on the bot, so a second `kick` for
// the same name replaces the timer instead of leaving two of them writing, and it
// clears itself on the first turn that finds the player gone.
function keepKicking(ctx, player, count) {
    const bot = ctx.bot;
    const key = cleanName(player.name);
    const payload = targetedTitle(player.name, count);
    if (!payload) return false;
    const loops = bot.kickLoops instanceof Map
        ? bot.kickLoops
        : (bot.kickLoops = new Map());

    clearInterval(loops.get(key));

    const online = () => !bot.destroyed && bot.online instanceof Map && bot.online.has(key);
    const send = () => {
        if (!online()) {
            clearInterval(loops.get(key));
            loops.delete(key);
            return;
        }
        ctx.run(payload);
    };

    // The first packet goes out with the command; only a delivery that the core
    // accepted starts the repeat.
    if (!online() || !ctx.run(payload)) return false;

    const timer = setInterval(send, KICK_INTERVAL_MS);
    timer.unref?.();
    loops.set(key, timer);
    return true;
}

module.exports = {
    name: 'kick',
    aliases: ['k'],
    description:
        `Disconnect one online player by name, IP, UUID or regex: a stack of ${TITLE_DEFAULT} entity selectors in a title aimed at them, ` +
        'repeated four times a second until they leave',
    usage: 'kick <player|ip|uuid|re:pattern|/pattern/> [count]',
    level: 'trusted',

    async execute(ctx) {
        // A trailing number is the selector count; everything before it is the
        // target, so a regex is free to contain spaces.
        const argv = [...ctx.args];
        let count = TITLE_DEFAULT;
        if (argv.length > 1 && /^\d+$/.test(argv[argv.length - 1])) {
            const last = Number(argv.pop());
            if (last > 0) count = last;
        }

        const raw = argv.join(' ').trim();
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

        // Four packets a second per match, until they are gone: a client that
        // reconnects before the server's timeout runs out is still the same name
        // in `online`, so the next packet is already on its way.
        const sent = [];
        for (const player of hits) {
            if (keepKicking(ctx, player, count)) sent.push(player.name);
        }
        if (!sent.length) return ctx.reply('Core is not ready; nothing was sent.');
        return ctx.reply(
            `Titling ${sent.length} x${count} four times a second until they leave: ${sent.join(', ')}`
        );
    }
};
