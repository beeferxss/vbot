'use strict';

// Spies on other bots' cores: a command block holding a command is a core block,
// and its own NBT is the only place the command can be read from. One block
// query per cell - the same packet the core uses to check its own blocks - spread
// over a box, and whatever comes back as a command is reported.
//
// This is the idea of ChomeNS' CoreSpyBot: it walks a box the size of a core and
// asks the server about every block in it. Here the sweep is paced instead of
// fired at full speed, things the server does not answer are counted instead of
// assumed, and the bot's own core queries are never mistaken for a spy answer
// (the transaction ids start far away from the core's own).

const MAX_IN_FLIGHT = 200;      // queries on their way at once
const FLUSH_MS = 50;            // how often the next batch goes out
const SWEEP_TIMEOUT_MS = 15000; // a server that stops answering cannot hang a sweep
const MAX_CELLS = 32768;        // a box bigger than this is a typo, not a core
const DEFAULT_SPAN = 8;         // blocks either side of the bot when no corners are given
const DEFAULT_HEIGHT = 5;       // blocks of height, centred on the bot
const WATCH_MS = 5000;          // how often watch mode sweeps again
const MAX_COMMAND = 300;        // a command block holds at most 32k, but a report does not

// NBT arrives typed on 1.20.2+ ({type, value}) and plain before that, and the
// field wanted can be nested anywhere in the answer.
function findField(node, wanted, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return undefined;
    if (node.type === 'compound' && node.value) return findField(node.value, wanted, depth + 1);
    if (Object.prototype.hasOwnProperty.call(node, wanted)) {
        return unwrap(node[wanted]);
    }
    for (const value of Object.values(node)) {
        const found = findField(value, wanted, depth + 1);
        if (found !== undefined) return found;
    }
    return undefined;
}

function unwrap(node) {
    if (node && typeof node === 'object' && typeof node.type === 'string' && 'value' in node) {
        return node.value;
    }
    return node;
}

// The command a block holds, or null when the block is not a command block (or
// holds an empty command, which is every freshly placed one).
function readCommand(nbt) {
    const field = findField(nbt, 'Command');
    if (typeof field !== 'string') return null;
    const command = field.trim().replace(/^\/+/, '');
    if (!command) return null;
    return command.length > MAX_COMMAND ? `${command.slice(0, MAX_COMMAND)}…` : command;
}

// A core block runs itself; a block someone placed by hand usually does not.
function readAuto(nbt) {
    const field = findField(nbt, 'auto');
    return field === 1 || field === '1' || field === true;
}

class BotCSpy {
    constructor({ bot, logger }) {
        this.bot = bot;
        this.log = logger;
        this.client = null;
        this.sweep = null;
        this.watchTimer = null;
        // Well clear of the core's own query ids, which count up from 0.
        this.nextId = 1000000;
        this.onPacket = this.onPacket.bind(this);
        this.onGenericPacket = this.onGenericPacket.bind(this);
    }

    get scanning() {
        return Boolean(this.sweep);
    }

    get watching() {
        return Boolean(this.watchTimer);
    }

    bind(client) {
        if (!client || this.client === client) return false;
        this.unbind();
        this.client = client;
        client.on('nbt_query_response', this.onPacket);
        // The packet is nbt_query_response on every version this handles; the
        // generic hook is there in case one renames it.
        client.on('packet', this.onGenericPacket);
        return true;
    }

    unbind() {
        if (!this.client) return false;
        this.client.removeListener('nbt_query_response', this.onPacket);
        this.client.removeListener('packet', this.onGenericPacket);
        this.client = null;
        return true;
    }

    onGenericPacket(data, meta) {
        const name = meta?.name || '';
        if (!/query.*nbt|nbt.*query/i.test(name)) return;
        this.onPacket(data);
    }

    onPacket(packet) {
        const sweep = this.sweep;
        if (!sweep || !packet) return false;

        const cell = sweep.pending.get(packet.transactionId);
        if (!cell) return false;
        sweep.pending.delete(packet.transactionId);
        sweep.answered += 1;

        const command = readCommand(packet.nbt);
        if (!command) return true;

        const known = sweep.found.get(command);
        if (known) {
            known.count += 1;
            if (known.cells.length < 4) known.cells.push(cell);
            return true;
        }
        sweep.found.set(command, {
            command,
            cell,
            cells: [cell],
            count: 1,
            auto: readAuto(packet.nbt)
        });
        return true;
    }

    // A box is two corners, as in fill: whichever way round they were given,
    // the low one and the high one are what the sweep walks.
    corners(from, to) {
        const low = {};
        const high = {};
        for (const axis of ['x', 'y', 'z']) {
            const a = Math.floor(Number(from?.[axis]));
            const b = Math.floor(Number(to?.[axis]));
            low[axis] = Math.min(a, b);
            high[axis] = Math.max(a, b);
        }
        return { from: low, to: high };
    }

    count({ from, to }) {
        return (to.x - from.x + 1) * (to.y - from.y + 1) * (to.z - from.z + 1);
    }

    // Every cell of the box, nearest its middle first, so a core right where the
    // bot looks is found before the sweep has even finished.
    cellsFor({ from, to }) {
        const cells = [];
        for (let y = from.y; y <= to.y; y++) {
            for (let x = from.x; x <= to.x; x++) {
                for (let z = from.z; z <= to.z; z++) {
                    cells.push({ x, y, z });
                }
            }
        }
        const middle = {
            x: (from.x + to.x) / 2,
            y: (from.y + to.y) / 2,
            z: (from.z + to.z) / 2
        };
        const distance = cell => Math.abs(cell.x - middle.x)
            + Math.abs(cell.y - middle.y)
            + Math.abs(cell.z - middle.z);
        return cells.sort((a, b) => distance(a) - distance(b));
    }

    // Where the bot stands, a box the size of a core around it, for when no
    // corners are given: the sweep stays useful without a fill line to copy.
    boxAt(at) {
        const x = Math.floor(at.x);
        const y = Math.floor(at.y);
        const z = Math.floor(at.z);
        const half = Math.floor(DEFAULT_SPAN);
        const tall = Math.floor(DEFAULT_HEIGHT / 2);
        return {
            from: { x: x - half, y: y - tall, z: z - half },
            to: { x: x + half, y: y + tall, z: z + half }
        };
    }

    // One pass over the box. Resolves with what answered and what held a command;
    // never rejects, because a server that says nothing is an answer too.
    scan({ from = null, to = null, timeoutMs = SWEEP_TIMEOUT_MS } = {}) {
        if (!this.bot?.write) return Promise.resolve({ ok: false, reason: 'no-write' });
        if (this.sweep) return Promise.resolve({ ok: false, reason: 'busy' });

        let box;
        if (from && to) {
            box = this.corners(from, to);
            if (!['x', 'y', 'z'].every(axis => Number.isFinite(box.from[axis]) && Number.isFinite(box.to[axis]))) {
                return Promise.resolve({ ok: false, reason: 'bad-box' });
            }
        } else {
            const at = this.bot.position;
            if (!at || !['x', 'y', 'z'].every(axis => Number.isFinite(at[axis]))) {
                return Promise.resolve({ ok: false, reason: 'no-position' });
            }
            box = this.boxAt(at);
        }

        const size = this.count(box);
        if (size > MAX_CELLS) return Promise.resolve({ ok: false, reason: 'too-big', cells: size });

        this.bind(this.bot.client);

        const cells = this.cellsFor(box);
        const sweep = {
            cells,
            pending: new Map(),
            found: new Map(),
            answered: 0,
            timer: null,
            deadline: null,
            finish: null
        };
        this.sweep = sweep;

        return new Promise(resolve => {
            let index = 0;

            // The two timers are kept on the sweep so stopping mid-sweep clears
            // them, and they are not unref'd: the promise they settle must keep
            // the caller (a command, a script) alive until it answers.
            const finish = reason => {
                if (this.sweep !== sweep) return;
                this.sweep = null;
                clearInterval(sweep.timer);
                clearTimeout(sweep.deadline);
                // Whatever never came back is unanswered, not empty.
                const misses = sweep.cells.length - sweep.answered;
                sweep.pending.clear();
                resolve({
                    ok: true,
                    reason,
                    from: box.from,
                    to: box.to,
                    cells: sweep.cells.length,
                    answered: sweep.answered,
                    misses,
                    found: [...sweep.found.values()]
                        .sort((a, b) => b.count - a.count)
                });
            };

            sweep.finish = finish;
            sweep.timer = setInterval(() => {
                while (index < sweep.cells.length && sweep.pending.size < MAX_IN_FLIGHT) {
                    const cell = sweep.cells[index++];
                    const transactionId = this.nextId++;
                    sweep.pending.set(transactionId, cell);
                    const sent = this.bot.write('query_block_nbt', {
                        transactionId,
                        location: { x: cell.x, y: cell.y, z: cell.z }
                    });
                    if (sent === false) sweep.pending.delete(transactionId);
                }
                if (index >= sweep.cells.length && sweep.pending.size === 0) finish('done');
            }, FLUSH_MS);

            sweep.deadline = setTimeout(
                () => finish('timeout'),
                Math.max(Number(timeoutMs) || 0, FLUSH_MS)
            );
        });
    }

    // Sweeps again every few seconds and hands each pass to onScan. With two
    // corners the box is that box on every pass; without them it is worked out
    // from where the bot stands, so a bot that walks does not spy on where it
    // used to be.
    watch({ from = null, to = null, everyMs = WATCH_MS, onScan = null } = {}) {
        if (this.watchTimer) return false;

        const pass = async () => {
            const result = await this.scan({ from, to });
            if (!result.ok) return;
            if (onScan) onScan(result);
        };

        pass();
        this.watchTimer = setInterval(pass, Math.max(Number(everyMs) || WATCH_MS, 1000));
        this.watchTimer.unref?.();
        return true;
    }

    stop(reason = 'stopped') {
        const was = this.watching || this.scanning;
        if (this.watchTimer) {
            clearInterval(this.watchTimer);
            this.watchTimer = null;
        }
        // A sweep on its way is settled, not dropped: whoever awaits it would
        // otherwise wait for a promise nothing can resolve any more.
        if (this.sweep?.finish) this.sweep.finish('stopped');
        this.sweep = null;
        if (was) this.log?.debug?.(`core spy ${reason}`);
        return was;
    }

    destroy() {
        this.stop('destroyed');
        this.unbind();
    }
}

module.exports = { BotCSpy, readCommand, readAuto, MAX_CELLS };
