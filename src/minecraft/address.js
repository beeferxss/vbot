'use strict';

// A Minecraft address is not always a host with an A record. play.norat.pw and
// alt.norat.pw have none at all: the only way in is their _minecraft._tcp SRV
// record, which is what a client looks up before it dials.
//
// minecraft-protocol follows that record itself, but only on its own default
// connect path - anything that hands the client a socket (the WARP proxy) skips
// it, and then the name is resolved by the far end, where it does not exist.

const dns = require('node:dns');
const net = require('node:net');

const TIMEOUT_MS = 3000;
const DEFAULT_PORT = 25565;

function resolveSrv(host, timeoutMs = TIMEOUT_MS) {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
        dns.resolveSrv(`_minecraft._tcp.${host}`, (error, records) => {
            clearTimeout(timer);
            if (error || !Array.isArray(records) || !records.length) return resolve(null);

            // Lowest priority wins; weight breaks the tie, as the record means.
            const [best] = records
                .slice()
                .sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
            const name = String(best?.name || '').replace(/\.$/, '');
            const port = Number(best?.port);
            if (!name || !Number.isInteger(port) || port < 1 || port > 65535) return resolve(null);
            resolve({ host: name, port });
        });
    });
}

// Where to dial, and nothing else: the name to say hello with stays the caller's
// business. A non-default port is the operator saying exactly where to go, and
// an IP has nothing to look up.
async function resolveServerAddress({ host, port } = {}) {
    const name = String(host || '').trim();
    const number = Number(port) > 0 ? Math.floor(Number(port)) : DEFAULT_PORT;
    if (!name || net.isIP(name) || number !== DEFAULT_PORT) return { host: name, port: number };
    return (await resolveSrv(name)) || { host: name, port: number };
}

module.exports = { resolveServerAddress, resolveSrv, DEFAULT_PORT };
