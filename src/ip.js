'use strict';

// Pulling addresses out of server chat. The bot cannot see where a player
// connects from, so an IP is only ever what a server command prints back - and
// plenty of servers mask them.

const IPV4 = /(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d)/g;
// Servers that "mask" an address still keep its shape with the last group
// blanked: 1.2.3.x, 1.2.3.*, 1.2.3.**, 1.2.3.?. Stored verbatim, so two accounts
// behind the same mask still land in the same bucket.
const MASKED = /(?<![\d.])(?:\d{1,3}\.){3}(?:x{1,3}|\*{1,3}|\?|\u2022|\u2588)(?![\w.])/gi;
const IPV6 = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;

function normalize(address) {
    return String(address || '').trim().toLowerCase();
}

// Version strings and ports look like addresses, so only an exact dotted quad,
// a masked quad, or a real colon-separated group counts.
function looksLikeIp(value) {
    const text = String(value || '').trim();
    if (!text) return false;

    if (new RegExp(`^${IPV4.source}$`).test(text)) return true;
    if (new RegExp(`^${MASKED.source}$`, 'i').test(text)) return true;
    if (!text.includes(':') || text.length < 3) return false;
    return /^[0-9a-f:]+$/i.test(text) && text.split(':').length >= 3;
}

function parseIps(text) {
    const source = String(text || '');
    if (!source) return [];

    const found = new Set();
    for (const match of source.match(IPV4) || []) found.add(normalize(match));
    for (const match of source.match(MASKED) || []) found.add(normalize(match));
    for (const match of source.match(IPV6) || []) {
        // A bare "1:2:3" is not an address; require a doubled colon unless it is
        // the full eight-group form.
        if (!match.includes('::') && match.split(':').length < 8) continue;
        found.add(normalize(match));
    }
    return [...found];
}

// "seen {player}" -> "seen Steve"; empty stays empty, so lookups stay off.
function lookupCommand(template, player) {
    const text = String(template || '').trim();
    if (!text || !player) return null;
    return text.replace(/\{player\}/gi, player).replace(/^\/+/, '');
}

module.exports = { looksLikeIp, normalize, parseIps, lookupCommand };
