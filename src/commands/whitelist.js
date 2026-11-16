'use strict';

const { isUuid } = require('../filter');

function cleanName(name) {
    return String(name || '').replace(/\u00a7[0-9a-fk-or]/gi, '').trim().toLowerCase();
}

function isIp(str) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(str || '').trim());
}

function listPreview(items, empty = '(none)') {
    if (!items || !items.length) return empty;
    const shown = items.slice(0, 10);
    const rest = items.length > 10 ? ` (+${items.length - 10} more)` : '';
    return shown.join(', ') + rest;
}

module.exports = {
    name: 'whitelist',
    aliases: ['wl'],
    description: 'Manage the whitelist (punishes non-whitelisted players when on)',
    usage: 'whitelist <on|off|status|clear|add|player|uuid|ip|rescan> ...',
    level: 'admin',

    async execute(ctx) {
        const w = ctx.bot.whitelist;
        if (!w) return ctx.reply('Whitelist is not available.');

        const sub = String(ctx.args[0] || 'status').toLowerCase();

        if (sub === 'status') {
            const d = w.getServerData();
            return ctx.reply(
                `whitelist ${d.enabled ? 'on' : 'off'} | players:${d.players.length} uuids:${d.uuids.length} ips:${d.ips.length}`
            );
        }

        if (sub === 'on') {
            w.on();
            return ctx.reply('Whitelist enabled.');
        }

        if (sub === 'off') {
            w.off();
            return ctx.reply('Whitelist disabled.');
        }

        if (sub === 'rescan' || sub === 'scan') {
            w.rescan();
            return ctx.reply('Rescanned online players for whitelist enforcement.');
        }

        if (sub === 'clear' || sub === 'reset' || sub === 'clearall') {
            w.clearAll();
            return ctx.reply('Cleared all whitelist data (players, uuids, ips).');
        }

        if (sub === 'add') {
            const target = ctx.args[1];
            if (!target) return ctx.reply(`Usage: ${ctx.prefix}whitelist add <player|uuid|ip>`);
            if (isUuid(target)) {
                return ctx.reply(w.addUUID(target) ? `Whitelisted uuid ${target}` : `Could not add ${target} (already present or invalid).`);
            }
            if (isIp(target)) {
                return ctx.reply(w.addIP(target) ? `Whitelisted ip ${target}` : `Could not add ${target} (already present).`);
            }
            return ctx.reply(w.addPlayer(target) ? `Whitelisted player ${cleanName(target)}` : `Could not add ${target} (already present).`);
        }

        if (sub === 'player' || sub === 'players' || sub === 'name' || sub === 'names') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}whitelist player add <name>`);
                return ctx.reply(w.addPlayer(v) ? `Whitelisted player ${cleanName(v)}` : 'Not added (already present).');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}whitelist player remove <name>`);
                return ctx.reply(w.removePlayer(v) ? `Removed whitelisted player ${cleanName(v)}` : 'Player not found.');
            }
            if (op === 'clear') {
                w.clearPlayers();
                return ctx.reply('Cleared whitelisted players.');
            }
            return ctx.reply(`Whitelisted players: ${listPreview(w.listPlayers())}`);
        }

        if (sub === 'uuid' || sub === 'uuids') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}whitelist uuid add <uuid>`);
                return ctx.reply(w.addUUID(v) ? `Whitelisted uuid ${v}` : 'Not added (invalid or already present).');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}whitelist uuid remove <uuid>`);
                return ctx.reply(w.removeUUID(v) ? `Removed whitelisted uuid ${v}` : 'UUID not found.');
            }
            if (op === 'clear') {
                w.clearUUIDs();
                return ctx.reply('Cleared whitelisted uuids.');
            }
            return ctx.reply(`Whitelisted uuids: ${listPreview(w.listUUIDs())}`);
        }

        if (sub === 'ip' || sub === 'ips') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}whitelist ip add <ip>`);
                return ctx.reply(w.addIP(v) ? `Whitelisted ip ${v}` : 'Not added (already present).');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}whitelist ip remove <ip>`);
                return ctx.reply(w.removeIP(v) ? `Removed whitelisted ip ${v}` : 'IP not found.');
            }
            if (op === 'clear') {
                w.clearIPs();
                return ctx.reply('Cleared whitelisted ips.');
            }
            return ctx.reply(`Whitelisted ips: ${listPreview(w.listIPs())}`);
        }

        return ctx.reply(`Usage: ${ctx.prefix}${this.usage}`);
    }
};
