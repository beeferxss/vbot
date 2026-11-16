'use strict';

const { cleanName, isUuid, isIp } = require('../filter');

function listPreview(items, empty = '(none)') {
    if (!items || !items.length) return empty;
    const shown = items.slice(0, 10);
    return shown.join(', ') + (items.length > 10 ? ` (+${items.length - 10} more)` : '');
}

module.exports = {
    name: 'filter',
    description: 'Manage the player filter (punish matching players)',
    usage: 'filter <on|off|status|player|uuid|ip|regex|mute|rescan|add> ...',
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
        if (sub === 'on') { f.on(); return ctx.reply('filter enabled.'); }
        if (sub === 'off') { f.off(); return ctx.reply('filter disabled.'); }
        if (sub === 'rescan' || sub === 'scan') { f.rescan(); return ctx.reply('filter rescanned online players.'); }

        if (sub === 'add') {
            const target = ctx.args[1];
            if (!target) return ctx.reply('Usage: filter add <player|uuid|ip>');
            if (isUuid(target)) {
                if (f.addUUID(target)) return ctx.reply(`filtered uuid ${target}`);
            } else if (isIp(target)) {
                if (f.addIP(target)) return ctx.reply(`filtered ip ${target}`);
            } else {
                if (f.addPlayer(target)) return ctx.reply(`filtered player ${cleanName(target)}`);
            }
            return ctx.reply(`Could not add ${target} (already present or invalid).`);
        }

        if (sub === 'player' || sub === 'players' || sub === 'name' || sub === 'names') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: filter player add <name>'); return ctx.reply(f.addPlayer(v) ? `filtered player ${cleanName(v)}` : 'not added'); }
            if (op === 'remove' || op === 'del' || op === 'delete') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: filter player remove <name>'); return ctx.reply(f.removePlayer(v) ? `removed player ${cleanName(v)}` : 'not found'); }
            if (op === 'clear') { f.clearPlayers(); return ctx.reply('cleared filtered players.'); }
            return ctx.reply(`filtered players: ${listPreview(f.listPlayers())}`);
        }

        if (sub === 'uuid' || sub === 'uuids') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: filter uuid add <uuid>'); return ctx.reply(f.addUUID(v) ? `filtered uuid ${v}` : 'not added (invalid or present)'); }
            if (op === 'remove' || op === 'del' || op === 'delete') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: filter uuid remove <uuid>'); return ctx.reply(f.removeUUID(v) ? `removed uuid ${v}` : 'not found'); }
            if (op === 'clear') { f.clearUUIDs(); return ctx.reply('cleared filtered uuids.'); }
            return ctx.reply(`filtered uuids: ${listPreview(f.listUUIDs())}`);
        }

        if (sub === 'ip' || sub === 'ips') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: filter ip add <ip>'); return ctx.reply(f.addIP(v) ? `filtered ip ${v}` : 'not added'); }
            if (op === 'remove' || op === 'del' || op === 'delete') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: filter ip remove <ip>'); return ctx.reply(f.removeIP(v) ? `removed ip ${v}` : 'not found'); }
            if (op === 'clear') { f.clearIPs(); return ctx.reply('cleared filtered ips.'); }
            return ctx.reply(`filtered ips: ${listPreview(f.listIPs())}`);
        }

        if (sub === 'regex') {
            const op = String(ctx.args[1] || 'show').toLowerCase();
            if (op === 'set') {
                const r = ctx.args.slice(2).join(' ').trim();
                if (!r) return ctx.reply('Usage: filter regex set <pattern>');
                return ctx.reply(f.setRegex(r) ? `filter regex set to ${f.getRegex()}` : 'invalid regex');
            }
            if (op === 'remove' || op === 'clear' || op === 'off') { f.removeRegex(); return ctx.reply('filter regex removed.'); }
            return ctx.reply(`filter regex: ${f.getRegex() || '(none)'}`);
        }

        if (sub === 'mute' || sub === 'mutes') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: filter mute add <target>'); return ctx.reply(f.addMute(v) ? `muting ${v} (filtered)` : 'not added'); }
            if (op === 'remove' || op === 'del' || op === 'delete') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: filter mute remove <target>'); return ctx.reply(f.removeMute(v) ? `removed mute ${v}` : 'not found'); }
            if (op === 'clear') { f.clearMutes(); return ctx.reply('cleared filter mutes.'); }
            const m = f.listMutes();
            if (!m.length) return ctx.reply('no filter mutes.');
            if (op === 'all') return ctx.reply(`filter mutes: ${m.join(', ')}`);
            return ctx.reply(`filter mutes (${m.length}): ${listPreview(m)}`);
        }

        ctx.reply(`Usage: ${ctx.prefix}${this.usage}`);
    }
};
