'use strict';

const { normalizeUuid } = require('./uuid');

// Player list packets changed shape across versions: older protocols send
// { action, data: [...] }, 1.19.3+ sends { actions, entries: [...] } where the
// name lives under "player". Both carry a name and a uuid somewhere, so scan
// every array we are given and every place a name can hide.
function playerInfoEntries(packet) {
    if (!packet || typeof packet !== 'object') return [];

    const lists = [packet.data, packet.entries, Array.isArray(packet) ? packet : null];
    const found = [];
    const seen = new Set();

    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (!entry || typeof entry !== 'object') continue;

            const name = entry.name
                ?? entry.playerName
                ?? entry.player?.name
                ?? entry.profile?.name;
            if (typeof name !== 'string' || !name) continue;

            const uuid = normalizeUuid(
                entry.uuid ?? entry.id ?? entry.player?.uuid ?? entry.profile?.uuid ?? entry.profile?.id
            );
            // 1.19.3+: an entry can be re-listed or hidden with "listed".
            const listed = typeof entry.listed === 'boolean' ? entry.listed : undefined;

            const key = `${name.toLowerCase()}:${uuid || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const entryOut = { name, uuid: uuid || null };
            if (listed !== undefined) entryOut.listed = listed;
            found.push(entryOut);
        }
    }

    return found;
}

module.exports = { playerInfoEntries };
