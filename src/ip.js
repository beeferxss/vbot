'use strict';

// Pulling addresses out of server chat. The bot cannot see where a player
// connects from, so an IP is only ever what a server command prints back.

const IPV4 = /(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d)/g;
const IPV6 = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;

// Version strings and ports look like addresses, so only an exact dotted quad
// or a real colon-separated group counts.
function looksLikeIp(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    IPV4.lastIndex = 0;
    if (new RegExp(`^${IPV4.source}$`).test(text)) return true;
    if (!text.includes(':') || text.length < 3) return false;
    return /^[0-9a-f:]+$/i.test(text) && text.split(':').length >= 3;
}

function parseIps(text) {
    const source = String(text || '');
    if (!source) return [];

    const found = new Set();
    for (const match of source.match(IPV4) || []) found.add(match);
    for (const match of source.match(IPV6) || []) {
        // A bare "1:2:3" is not an address; require at least a doubled colon
        // unless it is a full eight-group form.
        if (!match.includes('::') && match.split(':').length < 8) continue;
        found.add(match);
    }
    return [...found];
}

// Off unless the config asks for it: lookup commands are server specific.
function lookupCommand(template, player) {
    const text = String(template || '').trim();
    if (!text || !player) return null;
    return text.replace(/\{player\}/gi, player).replace(/^\/+/, '');
}

module.exports = { looksLikeIp, parseIps, lookupCommand };
