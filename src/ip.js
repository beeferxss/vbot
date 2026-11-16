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

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

// whois output carries the uuid too, which is worth keeping when the player
// list never showed it.
function parseUuid(text) {
    const match = UUID.exec(String(text || ''));
    return match ? match[0].toLowerCase() : null;
}

// The fields a whois reply carries, in the order they are worth showing.
const WHOIS_LABELS = [
    ['nick', /^nick$/i],
    ['uuid', /^uuid$/i],
    ['gamemode', /^gamemode$/i],
    ['health', /^health$/i],
    ['hunger', /^hunger$/i],
    ['exp', /^exp$/i],
    ['ip', /^(ip|ip address)$/i],
    ['op', /^op$/i],
    ['fly', /^fly( mode)?$/i],
    ['god', /^god( mode)?$/i],
    ['speed', /^speed$/i],
    ['money', /^money$/i],
    ['playtime', /^playtime$/i],
    ['afk', /^afk$/i],
    ['jail', /^jail$/i],
    ['muted', /^muted$/i],
    ['whitelist', /^whitelist$/i],
    ['location', /^location$/i]
];

// "- IP Address: /246.37.222.31" style lines into a plain object. Unknown lines
// are ignored, so a plugin that adds fields later cannot break anything.
function parseWhois(text) {
    const fields = {};

    for (const line of String(text || '').split('\n')) {
        const match = /^\s*[-\u2022*]\s*([A-Za-z][A-Za-z ]{1,24}):\s*(.*)$/.exec(line);
        if (!match) continue;

        const label = match[1].trim();
        const value = match[2].trim();
        if (!value) continue;

        const known = WHOIS_LABELS.find(([, pattern]) => pattern.test(label));
        if (!known) continue;
        fields[known[0]] = value;
    }

    if (fields.ip) {
        const ips = parseIps(fields.ip);
        if (ips.length) fields.ip = ips[0];
        else delete fields.ip;
    }
    if (fields.uuid && !UUID.test(fields.uuid)) delete fields.uuid;

    return fields;
}

// "whois {player}" -> "whois Steve"; empty stays empty, so lookups stay off.
function lookupCommand(template, player) {
    const text = String(template || '').trim();
    if (!text || !player) return null;
    return text.replace(/\{player\}/gi, player).replace(/^\/+/, '');
}

module.exports = { looksLikeIp, normalize, parseIps, parseUuid, parseWhois, lookupCommand };
