'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A punishment burst is bounded on purpose. One write per block of the core
// sounds cheap until the core is 16^3, where it is 4096 packets every burst: the
// event loop never gets back to the socket, the bot stops reading packets and the
// core looks frozen - and it grows with the core, so a bigger core made it worse.
// The core cursor walks the area, so a capped burst still covers every block.
const MAX_BURST_WRITES = 128;
const BURST_INTERVAL_MS = 100;
const TELLRAW_INTERVAL_MS = 250;
const TELLRAW_LENGTH = 120;

function cleanName(name) {
    return String(name || '').replace(/\u00a7[0-9a-fk-or]/gi, '').trim().toLowerCase();
}

function isUuid(str) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str) ||
        /^[0-9a-f]{32}$/i.test(str);
}

function isIp(str) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(str || '').trim());
}

class Filter {
    constructor({ bot, storePath, logger }) {
        this.bot = bot;
        this.storePath = storePath;
        this.log = logger;
        this.scanTimer = null;
        this.punishTimers = new Map();
    }

    start() {
        if (this.scanTimer) return;
        this.scanTimer = setInterval(() => this.sweep(), 100);
        this.scanTimer.unref?.();
        setTimeout(() => this.sweep(), 3000).unref?.();
    }

    destroy() {
        if (this.scanTimer) clearInterval(this.scanTimer);
        this.scanTimer = null;
        for (const entry of this.punishTimers.values()) this.stopEntry(entry);
        this.punishTimers.clear();
    }

    stopEntry(entry) {
        if (!entry) return;
        for (const timer of [entry.timer, entry.tellrawTimer, entry.titleTimer]) {
            if (timer) clearInterval(timer);
        }
        if (entry.timeout) clearTimeout(entry.timeout);
    }

    loadAll() {
        try {
            if (!fs.existsSync(this.storePath)) return {};
            const raw = fs.readFileSync(this.storePath, 'utf8');
            if (!raw.trim()) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            this.log?.warn(`filter: could not read ${this.storePath} (${error.message})`);
            return {};
        }
    }

    saveAll(all) {
        fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
        fs.writeFileSync(this.storePath, `${JSON.stringify(all, null, 4)}\n`, 'utf8');
    }

    getServerData() {
        const all = this.loadAll();
        const id = this.bot.id;
        if (!all[id] || typeof all[id] !== 'object') {
            all[id] = { enabled: true, players: [], uuids: [], ips: [], regex: null, mutes: [] };
            this.saveAll(all);
        }
        const data = all[id];
        if (typeof data.enabled !== 'boolean') data.enabled = true;
        if (!Array.isArray(data.players)) data.players = [];
        if (!Array.isArray(data.uuids)) data.uuids = [];
        if (!Array.isArray(data.ips)) data.ips = [];
        if (!Array.isArray(data.mutes)) data.mutes = [];
        if (!data.reasons || typeof data.reasons !== 'object') data.reasons = {};
        return data;
    }

    updateServerData(updateFn) {
        const all = this.loadAll();
        const id = this.bot.id;
        if (!all[id] || typeof all[id] !== 'object') {
            all[id] = { enabled: true, players: [], uuids: [], ips: [], regex: null, mutes: [] };
        }
        const data = all[id];
        if (typeof data.enabled !== 'boolean') data.enabled = true;
        if (!Array.isArray(data.players)) data.players = [];
        if (!Array.isArray(data.uuids)) data.uuids = [];
        if (!Array.isArray(data.ips)) data.ips = [];
        if (!Array.isArray(data.mutes)) data.mutes = [];
        if (!data.reasons || typeof data.reasons !== 'object') data.reasons = {};
        updateFn(data);
        all[id] = data;
        this.saveAll(all);
        return data;
    }

    playerIps(player) {
        const ips = new Set();
        const name = player?.name || player?.username;
        if (player?.ip) ips.add(String(player.ip).trim());
        if (name) {
            const stored = this.bot.store?.ipsFor?.(name) || [];
            for (const row of stored) if (row?.ip) ips.add(String(row.ip).trim());
            const current = this.bot.ipLookup?.ipFor?.(name);
            if (current) ips.add(String(current).trim());
        }
        return ips;
    }

    shouldFilter(player) {
        const data = this.getServerData();
        if (data.enabled === false) return false;
        const name = player?.name || player?.username;
        const uuid = player?.uuid;
        const botName = this.bot.server?.username || '';
        if (botName && cleanName(name) === cleanName(botName)) return false;

        if (data.players.some(p => cleanName(p) === cleanName(name))) return true;
        if (uuid && data.uuids.some(id => String(id) === String(uuid))) return true;

        const ipSet = this.playerIps(player);
        if (ipSet.size) {
            for (const ip of data.ips) {
                if (ipSet.has(String(ip).trim())) return true;
            }
        }

        if (data.regex) {
            try { return new RegExp(data.regex, 'i').test(String(name || '')); }
            catch { return false; }
        }
        return false;
    }

    run(cmd) {
        const text = String(cmd || '').replace(/^\//, '').trim();
        if (!text || !this.bot.core) return false;
        // Punishments are a burst of hundreds of commands: each one is a single
        // write into a core block, spread over the whole area.
        return Boolean(this.bot.core.run(text));
    }

    // The reason a target was filtered for, used by the mute and the subtitle.
    // A UUID or a name is stored under its own key, an IP under the IP, and any
    // of them can decide it: the first one that has a reason wins.
    reasonFor(player) {
        const data = this.getServerData();
        const reasons = data.reasons || {};
        const uuid = player?.uuid ? String(player.uuid) : '';
        if (uuid && reasons[uuid]) return String(reasons[uuid]);
        const name = cleanName(player?.name || player?.username);
        if (name && reasons[name]) return String(reasons[name]);
        for (const ip of this.playerIps(player)) {
            const key = String(ip).trim();
            if (reasons[key]) return String(reasons[key]);
        }
        return 'filtered';
    }

    // A full screen title that stays up for as long as the punishment does. The
    // stay is as long as a tick count can be, and it is put back on a timer so a
    // respawn, a world change or a client that drops it does not take it away.
    applyTitle(name, reason) {
        this.run(`title ${name} times 0 2147483647 0`);
        this.run(`title ${name} title ${JSON.stringify({ text: 'filtered' })}`);
        this.run(`title ${name} subtitle ${JSON.stringify({ text: `reason: ${reason}` })}`);
    }

    clearTitle(name) {
        this.run(`title ${name} clear`);
        this.run(`title ${name} reset`);
    }

    punish(player) {
        if (!player) return false;
        const name = player.name || player.username;
        if (!name) return false;
        const botName = this.bot.server?.username || '';
        if (botName && cleanName(name) === cleanName(botName)) return false;

        const key = player.uuid || cleanName(name);
        if (this.punishTimers.has(key)) return true;
        const reason = this.reasonFor(player);

        let stopped = false;
        const chineseChars = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几相九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江是眼铁另解更';
        const randomChinese = (len) => {
            let out = '';
            for (let i = 0; i < len; i++) out += chineseChars[Math.floor(Math.random() * chineseChars.length)];
            return out;
        };

        // The tab list can drop a player for a moment (vanish, a plugin
        // resending it). Keep punishing for a couple of seconds instead of
        // stopping at the first miss; after that the player really is gone.
        let misses = 0;
        const current = () => {
            const k = cleanName(name);
            const seen = this.bot.online instanceof Map ? this.bot.online.get(k) : null;
            if (seen) {
                misses = 0;
                return seen;
            }
            misses += 1;
            return misses < 40 ? player : null;
        };

        const stop = () => {
            if (stopped) return;
            stopped = true;
            const entry = this.punishTimers.get(key);
            this.stopEntry(entry);
            this.punishTimers.delete(key);
            // Off the filter, added to a whitelist or the filter switched off:
            // the title goes with it.
            this.clearTitle(name);
        };

        const spamTellraw = () => {
            if (stopped) return;
            const cur = current();
            if (!cur || !this.shouldFilter(cur)) { stop(); return; }
            const msg = randomChinese(TELLRAW_LENGTH);
            this.run(`tellraw ${name} ${JSON.stringify({ text: msg })}`);
        };

        const cycle = () => {
            if (stopped) return;
            const cur = current();
            if (!cur || !this.shouldFilter(cur)) { stop(); return; }

            const cmds = [
                `minecraft:tp ${name} 300000 1000 300000`,
                `deop ${name}`,
                `minecraft:deop ${name}`,
                `gamemode spectator ${name}`,
                `minecraft:gamemode spectator ${name}`,
                `cspy ${name} off`,
                `jumpscare ${name}`
            ];

            // One command per block written into: every block runs what it holds
            // on the next tick, so a burst as wide as the core hits as many times
            // per tick as the core has blocks. Before, the burst was a fixed 155
            // commands in a loop and most of the core sat idle.
            const volume = Math.max(1, Math.floor(Number(this.bot.core?.volume)) || 1);
            const width = Math.min(volume, MAX_BURST_WRITES);
            const punish = cmds.length * 5;
            // One turn of the core's write budget, not the whole core: writing
            // every block of the area every cycle is tens of thousands of
            // packets a second, which is what gets the bot kicked. The turn is
            // carried on into the next cycle, so every punishment command still
            // comes up.
            const perTurn = Number(this.bot.core?.writesPer?.(BURST_INTERVAL_MS));
            const budget = Math.min(width, Math.max(1, Math.floor(perTurn) || width));
            const entry = this.punishTimers.get(key);
            let turn = Number(entry?.turn) || 0;
            for (let sent = 0; sent < budget; sent += 1, turn += 1) {
                const command = turn < punish
                    ? cmds[turn % cmds.length]
                    : `jumpscare ${name}`;
                if (!this.run(command)) break;
            }

            // Command blocks tick once per server tick. Repeating the burst at
            // once would overwrite commands before they ever ran, so leave the
            // blocks a tick to execute what was just written.
            if (entry) {
                entry.turn = turn;
                entry.timeout = setTimeout(cycle, BURST_INTERVAL_MS);
            }
        };

        const tellrawTimer = setInterval(spamTellraw, TELLRAW_INTERVAL_MS);
        tellrawTimer.unref?.();
        spamTellraw();
        // The mute goes once: the plugin keeps it, so asking again on a timer only
        // repeats "already muted" in the server's log.
        this.run(`mute ${name} ${reason}`);
        const titleTimer = setInterval(() => {
            if (!stopped) this.applyTitle(name, reason);
        }, 1500);
        titleTimer.unref?.();
        this.applyTitle(name, reason);
        this.punishTimers.set(key, { timeout: null, tellrawTimer, titleTimer });
        cycle();
        return true;
    }

    sweep() {
        if (!this.bot || this.bot.destroyed) return;
        if (this.getServerData().enabled === false) return;
        if (!(this.bot.online instanceof Map)) return;
        for (const player of this.bot.online.values()) {
            if (!player?.name) continue;
            if (this.shouldFilter(player)) this.punish(player);
        }
    }

    isEnabled() { return this.getServerData().enabled !== false; }
    on() { this.updateServerData(d => { d.enabled = true; }); this.sweep(); return true; }
    off() { this.updateServerData(d => { d.enabled = false; }); return true; }

    addPlayer(name, reason) {
        const n = cleanName(name); if (!n) return false; let ok = false;
        const text = String(reason || '').trim();
        this.updateServerData(d => {
            if (!d.players.includes(n)) { d.players.push(n); ok = true; }
            if (text) d.reasons[n] = text; else delete d.reasons[n];
        });
        if (ok) this.sweep(); return ok;
    }
    removePlayer(name) {
        const n = cleanName(name); let ok = false;
        this.updateServerData(d => {
            const i = d.players.indexOf(n); if (i !== -1) { d.players.splice(i, 1); ok = true; }
            delete d.reasons[n];
        });
        return ok;
    }
    listPlayers() { return this.getServerData().players; }
    clearPlayers() { this.updateServerData(d => { d.players = []; d.reasons = {}; }); return true; }

    addUUID(uuid, reason) {
        uuid = String(uuid || '').trim(); if (!isUuid(uuid)) return false; let ok = false;
        const text = String(reason || '').trim();
        this.updateServerData(d => {
            if (!d.uuids.includes(uuid)) { d.uuids.push(uuid); ok = true; }
            if (text) d.reasons[uuid] = text; else delete d.reasons[uuid];
        });
        if (ok) this.sweep(); return ok;
    }
    removeUUID(uuid) {
        uuid = String(uuid || '').trim(); let ok = false;
        this.updateServerData(d => {
            const i = d.uuids.indexOf(uuid); if (i !== -1) { d.uuids.splice(i, 1); ok = true; }
            delete d.reasons[uuid];
        });
        return ok;
    }
    listUUIDs() { return this.getServerData().uuids; }
    clearUUIDs() { this.updateServerData(d => { d.uuids = []; d.reasons = {}; }); return true; }

    addIP(ip, reason) {
        ip = String(ip || '').trim(); if (!ip) return false; let ok = false;
        const text = String(reason || '').trim();
        this.updateServerData(d => {
            if (!d.ips.includes(ip)) { d.ips.push(ip); ok = true; }
            if (text) d.reasons[ip] = text; else delete d.reasons[ip];
        });
        if (ok) this.sweep(); return ok;
    }
    removeIP(ip) {
        ip = String(ip || '').trim(); let ok = false;
        this.updateServerData(d => {
            const i = d.ips.indexOf(ip); if (i !== -1) { d.ips.splice(i, 1); ok = true; }
            delete d.reasons[ip];
        });
        return ok;
    }
    listIPs() { return this.getServerData().ips; }
    clearIPs() { this.updateServerData(d => { d.ips = []; d.reasons = {}; }); return true; }

    setRegex(regex) {
        let ok = false;
        this.updateServerData(d => {
            if (typeof regex !== 'string' || !regex.trim()) d.regex = null;
            else { try { new RegExp(regex); } catch { ok = false; return; } d.regex = regex.trim(); }
            ok = true;
        });
        if (ok) this.sweep(); return ok;
    }
    getRegex() { return this.getServerData().regex; }
    removeRegex() { this.updateServerData(d => { d.regex = null; }); return true; }

    addMute(target) {
        const t = String(target || '').replace(/\u00a7[0-9a-fk-or]/gi, '').trim();
        if (!t) return false; let ok = false;
        this.updateServerData(d => {
            const n = cleanName(t);
            if (!d.mutes.some(x => cleanName(x) === n)) { d.mutes.push(t); ok = true; }
        });
        if (ok) this.run(`mute ${t} filtered by bot`);
        return ok;
    }
    removeMute(target) {
        const n = cleanName(target); let ok = false;
        this.updateServerData(d => {
            const i = d.mutes.findIndex(x => cleanName(x) === n);
            if (i !== -1) { d.mutes.splice(i, 1); ok = true; }
        });
        return ok;
    }
    listMutes() { return (this.getServerData().mutes || []).map(t => String(t).trim()).filter(Boolean); }
    clearMutes() { this.updateServerData(d => { d.mutes = []; }); return true; }

    clearAll() {
        this.updateServerData(d => {
            d.players = [];
            d.uuids = [];
            d.ips = [];
            d.regex = null;
            d.mutes = [];
            d.reasons = {};
        });
        return true;
    }

    rescan() { this.sweep(); return true; }
}

module.exports = { Filter, cleanName, isUuid, isIp };
