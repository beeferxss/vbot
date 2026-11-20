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
    const shown = items.slice(0, 12);
    const rest = items.length > 12 ? ` (+${items.length - 12} more)` : '';
    return shown.join(', ') + rest;
}

// `--all` is a flag, not part of anything else: it is taken off wherever it
// sits and the remaining words keep their order.
function splitAll(input) {
    const list = [...input];
    const at = list.lastIndexOf('--all');
    if (at === -1) return { args: list, all: false };
    list.splice(at, 1);
    return { args: list, all: true };
}

module.exports = {
    name: 'whitelist',
    aliases: ['wl'],
    description: 'Manage the whitelist',
    usage: 'whitelist <on|off|status|list|add|remove|clear|player|uuid|ip|rescan> ...',
    level: 'admin',

    async execute(ctx) {
        const w = ctx.bot.whitelist;
        if (!w) return ctx.reply('Whitelist is not available.');

        const { args, all } = splitAll(ctx.args);
        const sub = String(args[0] || 'status').toLowerCase();

        if (sub === 'status') {
            const d = w.getServerData();
            return ctx.reply(
                `whitelist ${d.enabled ? 'on' : 'off'} | players:${d.players.length} uuids:${d.uuids.length} ips:${d.ips.length}`
            );
        }

        if (sub === 'list') {
            const d = w.getServerData();
            return ctx.reply(
                `Whitelist ${d.enabled ? 'on' : 'off'}\n` +
                `Players: ${d.players.length ? d.players.join(', ') : '(none)'}\n` +
                `UUIDs: ${d.uuids.length ? d.uuids.join(', ') : '(none)'}\n` +
                `IPs: ${d.ips.length ? d.ips.join(', ') : '(none)'}`
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
            return ctx.reply('Cleared whitelist (players, uuids, ips).');
        }

        if (sub === 'add') {
            const target = args.slice(1).join(' ').trim();
            const scope = all ? ' on every server' : '';
            if (!target) return ctx.reply(`Usage: ${ctx.prefix}whitelist add <player|uuid|ip> [--all]`);
            if (isUuid(target)) {
                return ctx.reply(w.addUUID(target, all) ? `Whitelisted UUID ${target}${scope}` : `Could not add UUID ${target}.`);
            }
            if (isIp(target)) {
                return ctx.reply(w.addIP(target, all) ? `Whitelisted IP ${target}${scope}` : `Could not add IP ${target}.`);
            }
            return ctx.reply(w.addPlayer(target, all) ? `Whitelisted player ${cleanName(target)}${scope}` : `Could not add player ${target}.`);
        }

        if (sub === 'remove' || sub === 'del' || sub === 'delete') {
            const target = args.slice(1).join(' ').trim();
            if (!target) return ctx.reply(`Usage: ${ctx.prefix}whitelist remove <player|uuid|ip>`);
            let ok = false;
            if (isUuid(target)) ok = w.removeUUID(target);
            else if (isIp(target)) ok = w.removeIP(target);
            else {
                ok = w.removePlayer(target);
                if (!ok) ok = w.removeUUID(target);
                if (!ok) ok = w.removeIP(target);
            }
            return ctx.reply(ok ? `Removed ${target} from whitelist.` : `Could not find ${target} in whitelist.`);
        }

        if (sub === 'player' || sub === 'players' || sub === 'name' || sub === 'names') {
            const op = String(args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = args.slice(2).join(' ').trim();
                const scope = all ? ' on every server' : '';
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}whitelist player add <name> [--all]`);
                return ctx.reply(w.addPlayer(v, all) ? `Whitelisted player ${cleanName(v)}${scope}` : 'Not added.');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = args.slice(2).join(' ').trim();
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
            const op = String(args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = args.slice(2).join(' ').trim();
                const scope = all ? ' on every server' : '';
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}whitelist uuid add <uuid> [--all]`);
                return ctx.reply(w.addUUID(v, all) ? `Whitelisted UUID ${v}${scope}` : 'Not added.');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = args.slice(2).join(' ').trim();
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}whitelist uuid remove <uuid>`);
                return ctx.reply(w.removeUUID(v) ? `Removed whitelisted UUID ${v}` : 'UUID not found.');
            }
            if (op === 'clear') {
                w.clearUUIDs();
                return ctx.reply('Cleared whitelisted UUIDs.');
            }
            return ctx.reply(`Whitelisted UUIDs: ${listPreview(w.listUUIDs())}`);
        }

        if (sub === 'ip' || sub === 'ips') {
            const op = String(args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = args.slice(2).join(' ').trim();
                const scope = all ? ' on every server' : '';
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}whitelist ip add <ip|player> [--all]`);
                if (!isIp(v)) {
                    const ips = w.ipsFor(v);
                    if (!ips.length) return ctx.reply(`No known IPs for ${v}.`);
                    const added = ips.filter(ip => w.addIP(ip, all));
                    return ctx.reply(added.length
                        ? `Whitelisted ${added.length} IP(s) for ${v}${scope}: ${added.join(', ')}`
                        : `Those IPs are already whitelisted: ${ips.join(', ')}`);
                }
                return ctx.reply(w.addIP(v, all) ? `Whitelisted IP ${v}${scope}` : 'Not added.');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = args.slice(2).join(' ').trim();
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}whitelist ip remove <ip>`);
                return ctx.reply(w.removeIP(v) ? `Removed whitelisted IP ${v}` : 'IP not found.');
            }
            if (op === 'clear') {
                w.clearIPs();
                return ctx.reply('Cleared whitelisted IPs.');
            }
            return ctx.reply(`Whitelisted IPs: ${listPreview(w.listIPs())}`);
        }

        return ctx.reply(`Usage: ${ctx.prefix}${this.usage}`);
    }
};
