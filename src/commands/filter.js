'use strict';

const { cleanName, isUuid, isIp } = require('../filter');

function listPreview(items, empty = '(none)') {
    if (!items || !items.length) return empty;
    const shown = items.slice(0, 10);
    const rest = items.length > 10 ? ` (+${items.length - 10} more)` : '';
    return shown.join(', ') + rest;
}

module.exports = {
    name: 'filter',
    description: 'Manage the player filter (punishes matching players)',
    usage: 'filter <on|off|status|clear|add|player|uuid|ip|regex|mute|rescan> ...',
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

        if (sub === 'add') {
            const target = ctx.args[1];
            if (!target) return ctx.reply(`Usage: ${ctx.prefix}filter add <player|uuid|ip>`);
            if (isUuid(target)) {
                return ctx.reply(f.addUUID(target) ? `Added filtered uuid ${target}` : `Could not add ${target} (already present or invalid).`);
            }
            if (isIp(target)) {
                return ctx.reply(f.addIP(target) ? `Added filtered ip ${target}` : `Could not add ${target} (already present).`);
            }
            return ctx.reply(f.addPlayer(target) ? `Added filtered player ${cleanName(target)}` : `Could not add ${target} (already present).`);
        }

        if (sub === 'player' || sub === 'players' || sub === 'name' || sub === 'names') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter player add <name>`);
                return ctx.reply(f.addPlayer(v) ? `Added filtered player ${cleanName(v)}` : 'Not added (already present).');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = ctx.args[2];
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
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter uuid add <uuid>`);
                return ctx.reply(f.addUUID(v) ? `Added filtered uuid ${v}` : 'Not added (invalid or already present).');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter uuid remove <uuid>`);
                return ctx.reply(f.removeUUID(v) ? `Removed filtered uuid ${v}` : 'UUID not found.');
            }
            if (op === 'clear') {
                f.clearUUIDs();
                return ctx.reply('Cleared filtered uuids.');
            }
            return ctx.reply(`Filtered uuids: ${listPreview(f.listUUIDs())}`);
        }

        if (sub === 'ip' || sub === 'ips') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter ip add <ip>`);
                return ctx.reply(f.addIP(v) ? `Added filtered ip ${v}` : 'Not added (already present).');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter ip remove <ip>`);
                return ctx.reply(f.removeIP(v) ? `Removed filtered ip ${v}` : 'IP not found.');
            }
            if (op === 'clear') {
                f.clearIPs();
                return ctx.reply('Cleared filtered ips.');
            }
            return ctx.reply(`Filtered ips: ${listPreview(f.listIPs())}`);
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
            return ctx.reply(`Filter regex: ${f.getRegex() || '(none)'}`);
        }

        if (sub === 'mute' || sub === 'mutes') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') {
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter mute add <target>`);
                return ctx.reply(f.addMute(v) ? `Added filter mute for ${v}` : 'Not added (already present).');
            }
            if (op === 'remove' || op === 'del' || op === 'delete') {
                const v = ctx.args[2];
                if (!v) return ctx.reply(`Usage: ${ctx.prefix}filter mute remove <target>`);
                return ctx.reply(f.removeMute(v) ? `Removed filter mute for ${v}` : 'Mute target not found.');
            }
            if (op === 'clear') {
                f.clearMutes();
                return ctx.reply('Cleared filter mutes.');
            }
            const m = f.listMutes();
            if (!m.length) return ctx.reply('No filter mutes.');
            if (op === 'all') return ctx.reply(`Filter mutes: ${m.join(', ')}`);
            return ctx.reply(`Filter mutes (${m.length}): ${listPreview(m)}`);
        }

        return ctx.reply(`Usage: ${ctx.prefix}${this.usage}`);
    }
};
