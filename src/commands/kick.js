'use strict';

const { TELEPORT_INTERVAL_MS, targetedTeleport } = require('../crash');
const { cleanName, isUuid, isIp } = require('../filter');

// One target, five shapes. `@a`, `@p` and `@r` are selectors, handed to the
// server as they are; `re:` or `/.../` is a regex over the online names;
// anything that parses as a UUID or an address is matched as one; the rest is a
// name. The command never asks the caller which kind they meant.
function parseTarget(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    // Kept for the command itself; the arguments in brackets are the server's to
    // apply, so they are passed through untouched.
    const selector = text.match(/^@([aprs])(\[[^\]]*\])?$/i);
    if (selector) return { kind: 'selector', value: `@${selector[1].toLowerCase()}${selector[2] || ''}` };
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

// @p means nearest to the command, which runs at the core; the bot stands in
// that area, so its position picks the same player. Without positions to compare
// the first one in the list stands in.
function nearestPlayer(bot, players) {
    const at = bot.position;
    if (at && Number.isFinite(at.x) && Number.isFinite(at.z)) {
        let best = null;
        let bestDistance = Infinity;
        for (const player of players) {
            const position = player?.position;
            if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) continue;
            const distance = (position.x - at.x) ** 2 + (position.z - at.z) ** 2;
            if (distance < bestDistance) {
                bestDistance = distance;
                best = player;
            }
        }
        if (best) return best;
    }
    return players[0];
}

// The payload is the nether teleport at `TELEPORT_Y`, once per server tick:
// twenty a second, no title and no subtitle. It starts on `target` and keeps
// going until the loop says the target is gone: they left, the client dropped,
// or the server timed them out. The loop lives on the bot under `key`, so a
// second `kick` for the same target replaces the timer instead of leaving two
// of them writing, and it clears itself on the first turn that finds it gone.
function keepTeleporting(ctx, target, key, stillOnline) {
    const bot = ctx.bot;
    const command = targetedTeleport(target);
    if (!command) return false;
    const loops = bot.kickLoops instanceof Map
        ? bot.kickLoops
        : (bot.kickLoops = new Map());

    clearInterval(loops.get(key));

    const online = () => !bot.destroyed && stillOnline();
    const send = () => {
        if (!online()) {
            clearInterval(loops.get(key));
            loops.delete(key);
            return;
        }
        ctx.run(command);
    };

    // The first teleport goes out with the command; only a delivery that the
    // core accepted starts the repeat.
    if (!online() || !ctx.run(command)) return false;

    const timer = setInterval(send, TELEPORT_INTERVAL_MS);
    timer.unref?.();
    loops.set(key, timer);
    return true;
}

module.exports = {
    name: 'kick',
    aliases: ['k'],
    description:
        'Disconnect one online player by name, IP, UUID, regex or selector: the nether teleport ' +
        'to y=-20000000 twenty times a second, aimed at them until they leave; ' +
        '`kick stop` ends every kick that is still running',
    usage: 'kick <player|ip|uuid|re:pattern|/pattern/|@a|@p|@r> | kick stop',
    level: 'trusted',

    async execute(ctx) {
        // `stop` takes the word, so a player named "stop" cannot be kicked by
        // name; every other target is parsed as before.
        if (String(ctx.args[0] || '').trim().toLowerCase() === 'stop') {
            const loops = ctx.bot.kickLoops instanceof Map ? ctx.bot.kickLoops : null;
            const running = loops ? loops.size : 0;
            if (loops) {
                for (const timer of loops.values()) clearInterval(timer);
                loops.clear();
            }
            return ctx.reply(running
                ? `Stopped ${running} kick${running === 1 ? '' : 's'}.`
                : 'Nothing is being kicked.');
        }

        // The whole line is the target, so a regex is free to contain spaces.
        const raw = ctx.args.join(' ').trim();
        if (!raw) return ctx.reply(`Usage: ${ctx.prefix}${this.usage}`);

        const spec = parseTarget(raw);
        if (!spec) return ctx.reply(`Invalid regex: ${raw}`);

        const bot = ctx.bot;
        if (!bot?.core) return ctx.reply('Core is not ready.');

        const online = bot.online instanceof Map ? [...bot.online.values()] : [];
        const self = cleanName(bot.server?.username);
        const everyone = online.filter(player => player?.name && cleanName(player.name) !== self);

        // A selector stays a selector in the command, so the server resolves it
        // on every tick; the list only decides when the repeat starts and stops.
        // `@a` is one loop for the whole list, and @p/@r run until the player
        // they picked at the start is gone.
        if (spec.kind === 'selector') {
            if (!everyone.length) return ctx.reply(`Nobody online matches ${spec.value}.`);

            const base = spec.value.slice(0, 2);
            const sent = [];
            if (base === '@a') {
                const stillOnline = () => bot.online instanceof Map &&
                    [...bot.online.keys()].some(key => key !== self);
                if (keepTeleporting(ctx, spec.value, spec.value, stillOnline)) sent.push(spec.value);
            } else {
                const player = base === '@p'
                    ? nearestPlayer(bot, everyone)
                    : everyone[Math.floor(Math.random() * everyone.length)];
                const key = cleanName(player.name);
                const stillOnline = () => bot.online instanceof Map && bot.online.has(key);
                if (keepTeleporting(ctx, spec.value, key, stillOnline)) {
                    sent.push(`${spec.value} (${player.name})`);
                }
            }
            if (!sent.length) return ctx.reply('Core is not ready; nothing was sent.');
            return ctx.reply(
                `Kicking ${sent.length}: the nether teleport at y=-20000000 twenty times a second until they leave: ${sent.join(', ')}`
            );
        }

        const hits = everyone.filter(player => matches(bot, player, spec));
        if (!hits.length) return ctx.reply(`Nobody online matches ${raw}.`);

        // The nether teleport once per tick per match, until they are gone: a
        // client that reconnects before the server's timeout runs out is still
        // the same name in `online`, so the next teleport is already on its way.
        const sent = [];
        for (const player of hits) {
            const key = cleanName(player.name);
            const stillOnline = () => bot.online instanceof Map && bot.online.has(key);
            if (keepTeleporting(ctx, player.name, key, stillOnline)) sent.push(player.name);
        }
        if (!sent.length) return ctx.reply('Core is not ready; nothing was sent.');
        return ctx.reply(
            `Kicking ${sent.length}: the nether teleport at y=-20000000 twenty times a second until they leave: ${sent.join(', ')}`
        );
    }
};
