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
    return shown.join(', ') + (items.length > 10 ? ` (+${items.length - 10} more)` : '');
}

module.exports = {
    name: 'whitelist',
    aliases: ['wl'],
    description: 'Manage the whitelist (punish non-whitelisted players when on)',
    usage: 'whitelist <on|off|status|player|uuid|ip|rescan|add> ...',
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
        if (sub === 'on') { w.on(); return ctx.reply('whitelist enabled.'); }
        if (sub === 'off') { w.off(); return ctx.reply('whitelist disabled.'); }
        if (sub === 'rescan' || sub === 'scan') { w.rescan(); return ctx.reply('whitelist rescanned online players.'); }

        if (sub === 'add') {
            const target = ctx.args[1];
            if (!target) return ctx.reply('Usage: whitelist add <player|uuid|ip>');
            if (isUuid(target)) {
                if (w.addUUID(target)) return ctx.reply(`whitelisted uuid ${target}`);
            } else if (isIp(target)) {
                if (w.addIP(target)) return ctx.reply(`whitelisted ip ${target}`);
            } else {
                if (w.addPlayer(target)) return ctx.reply(`whitelisted player ${cleanName(target)}`);
            }
            return ctx.reply(`Could not add ${target} (already present or invalid).`);
        }

        if (sub === 'player' || sub === 'players' || sub === 'name' || sub === 'names') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: whitelist player add <name>'); return ctx.reply(w.addPlayer(v) ? `whitelisted player ${cleanName(v)}` : 'not added'); }
            if (op === 'remove' || op === 'del' || op === 'delete') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: whitelist player remove <name>'); return ctx.reply(w.removePlayer(v) ? `removed player ${cleanName(v)}` : 'not found'); }
            if (op === 'clear') { w.clearPlayers(); return ctx.reply('cleared whitelisted players.'); }
            return ctx.reply(`whitelisted players: ${listPreview(w.listPlayers())}`);
        }

        if (sub === 'uuid' || sub === 'uuids') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: whitelist uuid add <uuid>'); return ctx.reply(w.addUUID(v) ? `whitelisted uuid ${v}` : 'not added (invalid or present)'); }
            if (op === 'remove' || op === 'del' || op === 'delete') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: whitelist uuid remove <uuid>'); return ctx.reply(w.removeUUID(v) ? `removed uuid ${v}` : 'not found'); }
            if (op === 'clear') { w.clearUUIDs(); return ctx.reply('cleared whitelisted uuids.'); }
            return ctx.reply(`whitelisted uuids: ${listPreview(w.listUUIDs())}`);
        }

        if (sub === 'ip' || sub === 'ips') {
            const op = String(ctx.args[1] || 'list').toLowerCase();
            if (op === 'add') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: whitelist ip add <ip>'); return ctx.reply(w.addIP(v) ? `whitelisted ip ${v}` : 'not added'); }
            if (op === 'remove' || op === 'del' || op === 'delete') { const v = ctx.args[2]; if (!v) return ctx.reply('Usage: whitelist ip remove <ip>'); return ctx.reply(w.removeIP(v) ? `removed ip ${v}` : 'not found'); }
            if (op === 'clear') { w.clearIPs(); return ctx.reply('cleared whitelisted ips.'); }
            return ctx.reply(`whitelisted ips: ${listPreview(w.listIPs())}`);
        }

        ctx.reply(`Usage: ${ctx.prefix}${this.usage}`);
    }
};
