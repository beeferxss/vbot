'use strict';

// A server that filters bots deops them over and over instead of kicking them: the
// bot asks for op, gets it, is dropped again. A burst of deops in a minute is that
// filter. The answer is a different address - leave the server, turn the Cloudflare
// WARP address over, come back - and if three addresses are filtered as well, the
// bot stays where it is: a whitelist is what keeps it online then, and leaving
// would only lose the spot.

const WINDOW_MS = 60000;
const DEFAULT_LIMIT = 40;      // deops in a minute that mean "filtered"
const DEFAULT_ROTATIONS = 3;   // address changes before giving up and staying
const SETTLE_MS = 4000;        // a new address needs a moment before the client uses it

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class FilterGuard {
    constructor({ bot, config = {}, warp = null, logger }) {
        this.bot = bot;
        this.config = config || {};
        this.warp = warp;
        this.log = logger;

        this.enabled = this.config.enabled !== false;
        this.limit = Number(this.config.deopsPerMinute) > 0
            ? Math.floor(Number(this.config.deopsPerMinute))
            : DEFAULT_LIMIT;
        this.maxRotations = Number(this.config.rotations) >= 0
            ? Math.floor(Number(this.config.rotations))
            : DEFAULT_ROTATIONS;
        // A rotation changes the runner's own address, so every other bot on it
        // is talking from an address that no longer exists: they are restarted
        // too, but only when asked for.
        this.allServers = this.config.allServers === true;
        // How long the new address gets before the client reconnects; leave it at
        // the default unless a test needs it shorter.
        this.settleMs = Number(this.config.settleMs) >= 0
            ? Number(this.config.settleMs)
            : SETTLE_MS;

        this.opLevel = 0;
        this.deops = [];
        this.rotations = 0;
        this.busy = false;
        // Set once there is nothing left to try: the bot keeps its place in game.
        this.staying = false;
        this.filtered = false;
    }

    // The bot's own op level is all that is watched: someone else being deopped
    // says nothing about this bot.
    onEntityStatus(packet) {
        if (!this.enabled || !packet) return false;
        const status = Number(packet.entityStatus);
        if (!Number.isFinite(status) || status < 24 || status > 28) return false;

        const myId = this.bot?.client?.entityId;
        if (myId != null && Number(packet.entityId) !== Number(myId)) return false;

        const level = status - 24;
        const was = this.opLevel;
        this.opLevel = level;
        // A deop is op going from something to nothing.
        if (level !== 0 || was === 0) return false;
        return this.noteDeop();
    }

    // One deop, counted against the last minute.
    noteDeop(now = Date.now()) {
        this.deops.push(now);
        this.deops = this.deops.filter(at => now - at < WINDOW_MS);
        if (this.deops.length < this.limit) return false;

        this.deops = [];
        this.filtered = true;
        this.log?.warn?.(
            `the server deopped the bot ${this.limit} times in a minute; treating it as a filter`
        );
        // Recovery talks to the server and the network, so it is never awaited
        // from a packet handler.
        Promise.resolve(this.recover()).catch(error => {
            this.log?.error?.(`filter recovery failed: ${error.message}`);
        });
        return true;
    }

    // Leave, change the address, come back. After the last allowed change the bot
    // stays in game instead of trying again.
    async recover() {
        if (this.busy) return false;
        if (!this.enabled) return false;

        if (this.staying) {
            this.log?.debug?.('already filtered and staying in game; nothing to do');
            return false;
        }

        if (this.rotations >= this.maxRotations) {
            this.staying = true;
            this.log?.warn?.(
                `still filtered after ${this.rotations} address change(s); staying in game ` +
                '(a whitelist is what keeps the bot online now)'
            );
            return false;
        }

        if (!this.warp?.enabled) {
            this.staying = true;
            this.log?.warn?.(
                'the server is deopping the bot in a loop, but WARP is off in config; staying in game'
            );
            return false;
        }

        this.busy = true;
        this.rotations += 1;
        const attempt = `${this.rotations}/${this.maxRotations}`;
        this.log?.warn?.(`leaving the server and changing the WARP address (${attempt})`);

        this.bot.stop('filtered by the server');
        const rotated = await this.warp.rotate();
        if (!rotated) {
            this.staying = true;
            this.busy = false;
            this.log?.error?.('could not change the WARP address; staying in game');
            return false;
        }

        // The daemon reports connected before the address is actually in use.
        await sleep(this.settleMs);

        if (this.bot.destroyed) {
            this.busy = false;
            return false;
        }

        this.bot.start();
        this.filtered = false;
        if (this.allServers) this.restartOthers();
        this.busy = false;
        return true;
    }

    // Every other bot is talking from an address that was just replaced. They are
    // reconnected so they come back on the new one.
    restartOthers() {
        const manager = this.bot?.registry?.manager;
        if (!manager || typeof manager.list !== 'function') return 0;

        let restarted = 0;
        for (const other of manager.list()) {
            if (!other || other === this.bot || other.destroyed) continue;
            this.log?.info?.(`restarting ${other.id} on the new address`);
            other.stop('address changed');
            other.start();
            restarted += 1;
        }
        return restarted;
    }

    // A session starts over, but the count of address changes does not: three
    // tries are three tries for this bot, not three per reconnect.
    onReady() {
        this.opLevel = 0;
        this.deops = [];
        this.filtered = false;
    }

    status() {
        return {
            rotations: this.rotations,
            maxRotations: this.maxRotations,
            staying: this.staying,
            deops: this.deops.length,
            limit: this.limit
        };
    }

    destroy() {
        this.deops = [];
        this.busy = false;
    }
}

module.exports = { FilterGuard, WINDOW_MS, DEFAULT_LIMIT, DEFAULT_ROTATIONS };
