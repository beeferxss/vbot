'use strict';

const { cleanName, isUuid, isIp } = require('../filter');

function listPreview(items, empty = '(none)') {
    if (!items || !items.length) return empty;
    const shown = items.slice(0, 12);
    const rest = items.length > 12 ? ` (+${items.length - 12} more)` : '';
    return shown.join(', ') + rest;
}

module.exports = {
    name: 'filter',
    aliases: ['f'],
    description: 'Manage the player filter',
    usage: 'filter <on|off|status|list|add|remove|clear|player|uuid|ip|regex|mute|rescan> ...',
    level: 'admin',

    async execute(ctx) {
        const f = ctx.bot.filter;
        if (!f) return ctx.reply('Filter is not available.');

        const sub = String(ctx.args[0] || 'status').toLowerCase();

        if (sub === 'status') {
            const d = f.getServerData();
            return ctx.reply(
                `filter ${d.enabled !== false ? 'on' : 'off'} | players:${d.players.length} uuids:${d.uuids.length} ips:${d.ips.length} regex:${d.regex ? 'set' : 'none'} mutes:${(d.mutes || []).length}`
            );
        }

        if (sub === 'list') {
            const d = f.getServerData();
            return ctx.reply(
                `Filter ${d.enabled !== false ? 'on' : 'off'}\n` +
                `Players: ${d.players.length ? d.players.join(', ') : '(none)'}\n` +
                `UUIDs: ${d.uuids.length ? d.uuids.join(', ') : '(none)'}\n` +
                `IPs: ${d.ips.length ? d.ips.join(', ') : '(none)'}\n` +
                `Mutes: ${(d.mutes || []).length ? (d.mutes || []).join(', ') : '(none)'}\n` +
                `Regex: ${d.regex || '(none)'}`
            );
        }

        if (sub === 'on') {
            f.on();
            return ctx.reply('Filter enabled.');
        }

        if (sub === 'off') {
            f.off();
            return ctx.reply('Filter disabled.');
        }

        if (sub === 'rescan' || sub === 'scan') {
            f.rescan();
            return ctx.reply('Rescanned online players for filter matches.');
        }

        if (sub === 'clear' || sub === 'reset' || sub === 'clearall') {
            f.clearAll();
            return ctx.reply('Cleared all filter data (players, uuids, ips, regex, mutes).');
        }

        if (sub === 'clear-uuid' || sub === 'clearuuid') {
            f.clearUUIDs();
            return ctx.reply('Cleared filtered UUIDs.');
        }
        if (sub === 'clear-ip' || sub === 'clearip') {
            f.clearIPs();
            return ctx.reply('Cleared filtered IPs.');
        }
        if (sub === 'clear-mute' || sub === 'clearmute' || sub === 'clear-mutes' || sub === 'clearmutes') {
            f.clearMutes();
            return ctx.reply('Cleared filter mutes.');
        }

        if (sub === 'add') {
            const target = ctx.args.slice(1).join(' ').trim();
            if (!target) return ctx.reply(`Usage: ${ctx.prefix}filter add <player|uuid|ip>`);
            if (isUuid(target)) {
                return ctx.reply(f.addUUID(target) ? `Added filtered UUID ${target}` : `Could not add UUID ${target}.`);
            }
            if (isIp(target)) {
                return ctx.reply(f.addIP(target) ? `Added filtered IP ${target}` : `Could not add IP ${target}.`);
            }
            return ctx.reply(f.addPlayer(target) ? `Added filtered player ${cleanName(target)}` : `Could not add player ${target}.`);
        }

        if (sub === 'remove' || sub === 'del' || sub === 'delete') {
            const target = ctx.args.slice(1).join(' ').trim();
            if (!target) return ctx.reply(`Usage: ${ctx.prefix}filter remove <player|uuid|ip>`);
            let ok = false;
            if (isUuid(target)) ok = f.removeUUID(target);
            else if (isIp(target)) ok = f.removeIP(target);
            else {
                ok = f.removePlayer(target);
                if (!ok) ok = f.removeUUID(target);
                if (!ok) ok = f.removeIP(target);
                if (!ok) ok = f.removeMute(target);
            }
            return ctx.reply(ok ? `Removed ${target} from filter.` : `Could not find ${target} in filter.`);
        }

        if (sub === 'add-uuid' || sub === 'adduuid') {
            const v = ctx.args.slice(1).join(' ').trim();
            if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter add-uuid <uuid>`);
            return ctx.reply(f.addUUID(v) ? `Added filtered UUID ${v}` : `Could not add UUID ${v}.`);
        }
        if (sub === 'remove-uuid' || sub === 'removeuuid') {
            const v = ctx.args.slice(1).join(' ').trim();
            if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter remove-uuid <uuid>`);
            return ctx.reply(f.removeUUID(v) ? `Removed filtered UUID ${v}` : `UUID not found.`);
        }
        if (sub === 'add-ip' || sub === 'addip') {
            const v = ctx.args.slice(1).join(' ').trim();
            if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter add-ip <ip>`);
            return ctx.reply(f.addIP(v) ? `Added filtered IP ${v}` : `Could not add IP ${v}.`);
        }
        if (sub === 'remove-ip' || sub === 'removeip') {
            const v = ctx.args.slice(1).join(' ').trim();
            if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter remove-ip <ip>`);
            return ctx.reply(f.removeIP(v) ? `Removed filtered IP ${v}` : `IP not found.`);
        }

        if (sub === 'mute' || sub === 'mutes' || sub === 'unmute' || sub === 'remove-mute') {
            if (sub === 'unmute' || sub === 'remove-mute') {
                const v = ctx.args.slice(1).join(' ').trim();
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter unmute <target>`);
                return ctx.reply(f.removeMute(v) ? `Removed filter mute ${v}` : `Mute target not found.`);
            }
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = ctx.args.slice(2).join(' ').trim();
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter mute add <target>`);
                return ctx.reply(f.addMute(v) ? `Added filter mute ${v}` : 'Not added.');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = ctx.args.slice(2).join(' ').trim();
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter mute remove <target>`);
                return ctx.reply(f.removeMute(v) ? `Removed filter mute ${v}` : 'Mute target not found.');
            }
            if (op === 'clear') {
                f.clearMutes();
                return ctx.reply('Cleared filter mutes.');
            }
            return ctx.reply(`Filter mutes: ${listPreview(f.listMutes())}`);
        }

        if (sub === 'player' || sub === 'players' || sub === 'name' || sub === 'names') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = ctx.args.slice(2).join(' ').trim();
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter player add <name>`);
                return ctx.reply(f.addPlayer(v) ? `Added filtered player ${cleanName(v)}` : 'Not added.');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = ctx.args.slice(2).join(' ').trim();
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter player remove <name>`);
                return ctx.reply(f.removePlayer(v) ? `Removed filtered player ${cleanName(v)}` : 'Player not found.');
            }
            if (op === 'clear') {
                f.clearPlayers();
                return ctx.reply('Cleared filtered players.');
            }
            return ctx.reply(`Filtered players: ${listPreview(f.listPlayers())}`);
        }

        if (sub === 'uuid' || sub === 'uuids') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = ctx.args.slice(2).join(' ').trim();
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter uuid add <uuid>`);
                return ctx.reply(f.addUUID(v) ? `Added filtered UUID ${v}` : 'Not added.');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = ctx.args.slice(2).join(' ').trim();
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter uuid remove <uuid>`);
                return ctx.reply(f.removeUUID(v) ? `Removed filtered UUID ${v}` : 'UUID not found.');
            }
            if (op === 'clear') {
                f.clearUUIDs();
                return ctx.reply('Cleared filtered UUIDs.');
            }
            return ctx.reply(`Filtered UUIDs: ${listPreview(f.listUUIDs())}`);
        }

        if (sub === 'ip' || sub === 'ips') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = ctx.args.slice(2).join(' ').trim();
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter ip add <ip>`);
                return ctx.reply(f.addIP(v) ? `Added filtered IP ${v}` : 'Not added.');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = ctx.args.slice(2).join(' ').trim();
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter ip remove <ip>`);
                return ctx.reply(f.removeIP(v) ? `Removed filtered IP ${v}` : 'IP not found.');
            }
            if (op === 'clear') {
                f.clearIPs();
                return ctx.reply('Cleared filtered IPs.');
            }
            return ctx.reply(`Filtered IPs: ${listPreview(f.listIPs())}`);
        }

        if (sub === 'regex') {
            const op = String(ctx.args[1] || 'show').toLowerCase();
            if (op === 'set') {
                const r = ctx.args.slice(2).join(' ').trim();
                if (!r) return ctx.reply(`Usage: ${ctx.prefix}filter regex set <pattern>`);
                return ctx.reply(f.setRegex(r) ? `Filter regex set to ${f.getRegex()}` : 'Invalid regex.');
            }
            if (op === 'remove' || op === 'clear' || op === 'off') {
                f.removeRegex();
                return ctx.reply('Filter regex removed.');
            }
            if (op === 'get' || op === 'list' || op === 'show') {
                return ctx.reply(`Filter regex: ${f.getRegex() || '(none)'}`);
            }
            return ctx.reply(`Filter regex: ${f.getRegex() || '(none)'}`);
        }

        return ctx.reply(`Usage: ${ctx.prefix}${this.usage}`);
    }
};
