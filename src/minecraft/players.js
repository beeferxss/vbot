'use strict';

const { normalizeUuid } = require('./uuid');

// Player list packets changed shape across versions: older protocols send
// { action, data: [...] }, 1.19.3+ sends { entries: [...] }. Both carry entries
// with a name and a uuid, so scan every array we are given instead of trusting
// one field name.
function playerInfoEntries(packet) {
    if (!packet || typeof packet !== 'object') return [];

    const lists = [packet.data, packet.entries, Array.isArray(packet) ? packet : null];
    const found = [];
    const seen = new Set();

    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (!entry || typeof entry !== 'object') continue;
            const name = entry.name ?? entry.playerName;
            const uuid = normalizeUuid(entry.uuid ?? entry.id);
            if (typeof name !== 'string' || !name || !uuid) continue;
            const key = `${name.toLowerCase()}:${uuid}`;
            if (seen.has(key)) continue;
            seen.add(key);
            found.push({ name, uuid });
        }
    }

    return found;
}

module.exports = { playerInfoEntries };
