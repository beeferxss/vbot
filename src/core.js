'use strict';

// The core is a cube of command blocks. Commands are written into the blocks with
// the update_command_block packet, which keeps them off the chat log, and the
// area is refilled with /fill whenever something breaks a block.

const tellraw = require('./minecraft/tellraw');
const { flatten } = require('./minecraft/text');
const { FillItem } = require('./fillitem');

// The core's name runs through these colours, one step per character, so it
// reads as a single word instead of a flat block of colour.
const NAME_GRADIENT = [[0x55, 0xff, 0xff], [0x55, 0x55, 0xff], [0xff, 0x55, 0xff]];

function gradientParts(text) {
    const chars = [...String(text)];
    if (!chars.length) return [];

    const last = NAME_GRADIENT.length - 1;
    return chars.map((char, index) => {
        const at = chars.length === 1 ? 0 : (index / (chars.length - 1)) * last;
        const from = Math.min(Math.floor(at), last);
        const to = Math.min(from + 1, last);
        const t = at - from;
        const [r1, g1, b1] = NAME_GRADIENT[from];
        const [r2, g2, b2] = NAME_GRADIENT[to];

        const color = '#' + [r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]
            .map(value => Math.round(value).toString(16).padStart(2, '0'))
            .join('');

        return { text: char, color, bold: true };
    });
}

const OWN_CHANGE_MS = 5000;
const DAMAGE_DELAY_MS = 250;
const REFILL_SETTLE_MS = 200;
const WATCHDOG_MS = 1000;
const DEFAULT_SPAM_MS = 150;
// A fill's own block updates can arrive a second or more later, and a refill
// twice in a row is never useful, so both the grace and the rate limit are
// generous. Without them one slow update looped refills forever.
const REFILL_GRACE_MS = 3000;
const REFILL_MIN_INTERVAL_MS = 1500;

class Core {
    constructor({ bot, config, logger }) {
        this.bot = bot;
        this.log = logger;
        this.config = config || {};
        this.enabled = this.config.enabled !== false;

        this.size = positive(this.config.area?.size, 9);
        this.y = Number.isFinite(Number(this.config.area?.y)) ? Number(this.config.area.y) : 64;
        this.block = String(this.config.refill?.block || 'minecraft:repeating_command_block');
        // Optional display name, as raw SNBT component text, for example
        // {"text":"vbot","color":"green"} -> block{CustomName:'...'}.
        this.name = this.config.name ? String(this.config.name) : null;
        this.mode = String(this.config.refill?.mode || 'replace');
        this.refillEnabled = this.config.refill?.enabled !== false;

        // prismarine-chunk is loaded lazily, per protocol version, for the
        // chunk checks; a version without data must not break the core.
        this.chunkFactories = new Map();
        this.origin = { x: null, y: this.y, z: null };
        this.bounds = { x: null, y: this.y + this.size - 1, z: null };
        this.cursor = 0;
        this.ready = false;
        this.everReady = false;
        this.refilling = false;
        this.damageTimer = null;
        this.ownChanges = new Map();
        this.lastRefillAt = 0;
        // key -> alive. Populated when a fill lands, then pruned by block changes.
        this.blocks = new Map();
        this.graceUntil = 0;
        // Last block update seen inside the area. A fill that never reached the
        // world sends none, which is how an item refill is checked.
        this.lastChangeAt = 0;
        this.verifyTimer = null;
        this.watchdog = null;
        this.watchdogMs = positive(this.config.refill?.intervalMs, WATCHDOG_MS);
        // A burst of refills through the blocks, for when the area has to be back
        // now rather than eventually.
        this.spamTimer = null;
        this.spam = null;
        this.spamMs = positive(this.config.refill?.spamMs, DEFAULT_SPAM_MS);
        // The bot's own command block, a one-block mini core: everything is
        // edited into it and it runs against the main core.
        this.fillItem = this.config.refill?.item === false
            ? null
            : new FillItem({ bot, logger, config: this.config.refill });
        this.itemFills = 0;
        // Result the server reported for the last fill it ran for us.
        this.lastFill = null;
        this.fillFailures = 0;
        // Where the last command landed, and the queries waiting for an answer.
        this.lastLocation = null;
        this.client = null;
        this.queryId = 1;
        this.queries = new Map();
        // Log throttling to avoid console spam under load.
        this._lastLog = new Map();
    }

    get volume() {
        return this.size ** 3;
    }

    logEvery(key, ms, level, ...args) {
        const now = Date.now();
        const last = this._lastLog.get(key) || 0;
        if (now - last < ms) return false;
        this._lastLog.set(key, now);
        (this.log[level] || this.log.info).call(this.log, ...args);
        return true;
    }

    status() {
        if (!this.enabled) return 'core is disabled in config';
        if (this.origin.x === null) return 'core not placed yet (no position seen)';
        const { origin, bounds } = this;
        return `core ${this.size}^3 at ${origin.x} ${origin.y} ${origin.z}..${bounds.x} ${bounds.y} ${bounds.z}, ` +
            `${this.ready ? 'ready' : this.refilling ? 'refilling' : 'not ready'}, cursor ${this.cursor}/${this.volume}, ` +
            `name ${this.name ? this.name : 'none'}`;
    }

    // The configured name as components, one per character, so it shows up with
    // a gradient in chat.
    nameParts() {
        if (!this.name) return [{ text: 'none', color: 'dark_gray' }];

        let component = this.name;
        try {
            component = JSON.parse(this.name);
        } catch {
            // A plain string name is perfectly valid.
        }

        const text = flatten(component);
        return text ? gradientParts(text) : [{ text: this.name, color: 'white' }];
    }

    // The server reports how many blocks a fill changed, and that is the only
    // confirmation we get: a fill that changed nothing never ran. Servers send
    // this as a translated key, so the raw text carries the count.
    noteMessage(line) {
        const text = String(line || '');

        // Every write into a core command block is confirmed with the command
        // that was written. That is our own bookkeeping, not chat, so it is
        // swallowed here instead of reaching the console feed or Discord.
        if (/^(?:Command set\b|advMode\.setCommand|commands\.setblock\.success|Changed the block at)/i.test(text)) {
            return true;
        }

        // The count is how many blocks the fill *changed*, not how many it set,
        // so a small number is normal: a core already in place changes nothing.
        const success = /commands\.fill\.success(\d+)/i.exec(text)
            || /Successfully filled (\d+)/i.exec(text);
        if (success) {
            const blocks = Number(success[1]);
            this.lastFill = { blocks, expected: this.volume, ok: true, at: Date.now() };
            this.fillFailures = 0;
            this.log.debug(blocks === 0
                ? 'core fill changed nothing: the core is already in place'
                : `core fill changed ${blocks} block(s)`);
            return true;
        }

        const failed = /commands\.fill\.failed/i.test(text)
            || /No blocks were filled/i.test(text)
            || /commands\.fill\.no\\?/i.test(text);
        if (failed) {
            // "No blocks were filled" is also what the server says when every
            // block already matches, which is the good case: standing blocks
            // mean there is nothing to repair, so this is not a failure.
            if (this.survivor()) {
                this.markAllAlive();
                this.ready = true;
                this.everReady = true;
                this.lastFill = { blocks: 0, expected: this.volume, ok: true, at: Date.now() };
                this.fillFailures = 0;
                this.log.debug('core fill changed nothing: the core is already in place');
            } else {
                this.lastFill = { blocks: 0, expected: this.volume, ok: false, at: Date.now() };
                this.fillFailures += 1;
                this.logEvery('fill-failed', 5000, 'warn',
                    'core fill failed and no core blocks are standing ' +
                    '(not opped, protected area, or an unloaded chunk?)'
                );
            }
            return true;
        }

        return false;
    }

    // Status as tellraw parts rather than one string, so the name is coloured.
    statusParts() {
        if (!this.enabled) return [{ text: 'core is disabled in config', color: 'gray' }];
        if (this.origin.x === null) {
            return [{ text: 'core not placed yet (no position seen)', color: 'gray' }];
        }

        const { origin, bounds } = this;
        return [
            { text: 'core ', color: 'gray' },
            { text: `${this.size}^3`, color: 'aqua' },
            { text: ` at ${origin.x} ${origin.y} ${origin.z}..${bounds.x} ${bounds.y} ${bounds.z}, `, color: 'gray' },
            {
                text: this.ready ? 'ready' : this.refilling ? 'refilling' : 'not ready',
                color: this.ready ? 'green' : 'yellow'
            },
            { text: `, cursor ${this.cursor}/${this.volume}, name `, color: 'dark_gray' },
            ...this.nameParts(),
            ...(this.lastFill
                ? [{
                    text: this.lastFill.ok === false
                        ? ', last fill failed'
                        : `, last fill changed ${this.lastFill.blocks}`,
                    color: this.lastFill.ok === false ? 'red' : 'dark_gray'
                }]
                : [])
        ];
    }

    // Grid-aligned to the bot's chunk so the core stays put while it walks.
    reset(position = this.bot.position) {
        if (!this.enabled) return false;
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return false;

        const x = Math.floor(position.x / this.size) * this.size;
        const z = Math.floor(position.z / this.size) * this.size;

        this.origin = { x, y: this.y, z };
        this.bounds = { x: x + this.size - 1, y: this.y + this.size - 1, z: z + this.size - 1 };
        this.cursor = 0;
        this.ready = false;
        this.ownChanges.clear();
        this.blocks.clear();
        this.log.debug(`core area ${this.origin.x} ${this.origin.y} ${this.origin.z}`);
        return true;
    }

    // viaChat forces the fill out as a chat command instead of a block write.
    // Automatic refills prefer a block; the explicit command asks for chat.
    refill(reason = 'manual', { viaChat = false, force = false } = {}) {
        if (!this.enabled || !this.refillEnabled) return false;
        if (this.origin.x === null && !this.reset()) return false;

        // Never refill on top of a refill: the block updates from the last fill
        // look like damage, and reacting to them loops forever.
        if (!force && this.refilling) return false;
        if (!force && Date.now() - this.lastRefillAt < REFILL_MIN_INTERVAL_MS) {
            this.log.debug(`core refill (${reason}) skipped, last one was too recent`);
            return false;
        }

        const command = this.fillCommand();

        // The bot's own command block comes first: it is the mini core, so a
        // refill only replaces the command inside it and the block fills the
        // main core itself. Its own blocks are never written to directly.
        let viaCore = false;
        let viaItem = false;
        let usedSurvivor = null;
        // Forced refills are allowed on top of a fill still in flight: the bot's
        // block only has its command replaced, so nothing is placed twice.
        if (!viaChat && this.everReady && this.origin.x !== null) {
            viaItem = Boolean(this.placeFill(command));
            viaCore = viaItem;
        }

        // Whatever is left of the main core refills it when there is no block of
        // the bot's own: writing the fill into a surviving block needs no item
        // and no chat. Explicit refill commands (viaChat) skip this.
        if (!viaChat && !viaCore && !this.refilling && this.everReady && this.origin.x !== null) {
            for (const [id, alive] of this.blocks) {
                if (!alive) continue;
                const [sx, sy, sz] = id.split(':').map(Number);
                const cell = { x: sx, y: sy, z: sz };
                this.markOwn(cell);
                const ok = Boolean(this.bot.write?.('update_command_block', {
                    location: cell,
                    command,
                    mode: this.blockMode(),
                    flags: 0b101
                }));
                if (ok) {
                    viaCore = true;
                    usedSurvivor = cell;
                    break;
                }
                this.ownChanges.delete(keyOf(cell));
                this.blocks.set(keyOf(cell), false);
            }
        }

        // Chat is the last resort, never a second attempt on top of a block: a
        // server that silences command block output would otherwise get every
        // fill twice. Explicit refill commands request chat directly.
        if (!viaCore) this.sendFill(command);

        this.refilling = true;
        // Keep the core usable across rebuilds once it has worked at least once.
        if (!this.everReady) this.ready = false;
        // The fill itself produces a block change per cell; those are ours.
        this.graceUntil = Date.now() + REFILL_GRACE_MS;
        let place = 'chat';
        if (viaItem) place = 'its own command block';
        else if (viaCore && usedSurvivor) place = `block ${usedSurvivor.x} ${usedSurvivor.y} ${usedSurvivor.z}`;
        if (reason === 'startup' || reason === 'manual' || reason === 'command') {
            this.log.info(`core refill (${reason}) via ${place}`);
        } else {
            this.log.debug(`core refill (${reason}) via ${place}`);
        }

        // A refill through the bot's own block cannot report failure: the slot
        // packet and the placement are accepted even when the server drops them.
        // Check for a real block update and send the fill as chat if nothing changed.
        if (viaItem) this.verifyItemFill(command);

        setTimeout(() => {
            this.refilling = false;
            this.ready = true;
            this.everReady = true;
            this.lastRefillAt = Date.now();
            this.markAllAlive();
        }, REFILL_SETTLE_MS).unref?.();

        return true;
    }

    // Plain chat, never routed back into the core: a fill has to reach the
    // server even when the core itself is the thing that is broken.
    sendFill(command) {
        const text = String(command || '').trim();
        if (!text) return false;
        const withSlash = text.startsWith('/') ? text : `/${text}`;
        if (typeof this.bot.sendChat === 'function') return this.bot.sendChat(withSlash) !== false;
        if (typeof this.bot.client?.chat === 'function') {
            this.bot.client.chat(withSlash);
            return true;
        }
        if (typeof this.bot.chat === 'function') return this.bot.chat(withSlash) !== false;
        return false;
    }

    verifyItemFill(command) {
        if (this.verifyTimer) clearTimeout(this.verifyTimer);
        const startedAt = Date.now();
        const wait = Math.max(700, (this.fillItem?.holdMs || 250) + 450);
        this.verifyTimer = setTimeout(() => {
            this.verifyTimer = null;
            if (!this.enabled || this.bot.destroyed) return;
            // Any block update inside the area means the fill reached the world.
            if (this.lastChangeAt >= startedAt) return;
            this.fillFailures += 1;
            this.logEvery('item-fill-unconfirmed', 10000, 'warn',
                "the bot's command block did not fill the core (placement refused?); sending the fill as chat");
            this.sendFill(command);
        }, wait);
        this.verifyTimer.unref?.();
    }

    // Runs the fill through the bot's own command block, placing it when there is
    // none. Returns the block that holds the fill, or null when that is not an
    // option on this server.
    placeFill(command) {
        if (!this.fillItem?.usable) return null;
        const cell = this.fillItem.run(command);
        if (!cell) return null;
        this.itemFills += 1;
        return cell;
    }

    // The fill that rebuilds the whole area, as a bare command.
    fillCommand() {
        const { origin, bounds } = this;
        return `fill ${origin.x} ${origin.y} ${origin.z} ` +
            `${bounds.x} ${bounds.y} ${bounds.z} ${this.blockSpec()} ${this.mode}`;
    }

    // A burst of refills through the blocks. Nothing goes out as chat, so the
    // area can be rebuilt several times a second: each write lands in a command
    // block and runs on the next tick, which is as fast as the server goes.
    startSpam({ intervalMs, durationMs } = {}) {
        if (!this.enabled || !this.refillEnabled) return false;
        if (this.spamTimer) return false;
        if (this.origin.x === null && !this.reset()) return false;

        const every = positive(intervalMs, this.spamMs);
        // No duration means it runs until it is switched off.
        const total = Number(durationMs) > 0 ? Number(durationMs) : Infinity;
        this.spam = { startedAt: Date.now(), count: 0, intervalMs: every, durationMs: total };

        this.spamTimer = setInterval(() => {
            if (!this.enabled || !this.refillEnabled) return this.stopSpam('disabled');
            if (Date.now() - this.spam.startedAt >= this.spam.durationMs) return this.stopSpam('finished');

            // Our own fills change blocks; none of that is damage.
            this.graceUntil = Date.now() + REFILL_GRACE_MS;
            // Into the core's own blocks: there is no faster path, and at this
            // interval nothing else could keep up.
            const command = this.fillCommand();
            if (this.run(command)) this.spam.count += 1;
        }, every);
        this.spamTimer.unref?.();

        this.log.info(
            total === Infinity
                ? `core spam refill: every ${every}ms until stopped`
                : `core spam refill: every ${every}ms for ${total}ms`
        );
        return true;
    }

    stopSpam(reason = 'stopped') {
        if (!this.spamTimer) return false;
        clearInterval(this.spamTimer);
        this.spamTimer = null;

        const count = this.spam?.count || 0;
        this.spam = null;
        this.graceUntil = Date.now() + REFILL_GRACE_MS;
        this.ready = true;
        this.lastRefillAt = Date.now();
        this.markAllAlive();
        this.log.info(`core spam refill ${reason} after ${count} fill(s)`);
        return true;
    }

    spamStatus() {
        if (!this.spam) return { running: false, intervalMs: this.spamMs };
        return {
            running: true,
            intervalMs: this.spam.intervalMs,
            count: this.spam.count,
            leftMs: Number.isFinite(this.spam.durationMs)
                ? Math.max(0, this.spam.durationMs - (Date.now() - this.spam.startedAt))
                : null
        };
    }

    // Spreads commands over the cube instead of hammering one block, so a
    // command never lands in the block that is currently executing. Destroyed
    // blocks are skipped, so a command is never written into nothing.
    run(command) {
        if (!this.enabled) return null;
        const text = String(command || '').trim().replace(/^\//, '');
        if (!text) return null;

        // The bot's own block is the mini core: the command is edited into it and
        // it runs against the main core, so no core block is written directly.
        const own = this.fillItem?.run(text.slice(0, 32000));
        if (own) {
            this.lastLocation = own;
            return own;
        }

        if (this.origin.x === null && !this.reset()) return null;

        if (!this.areaLoaded()) {
            this.logEvery('core-unloaded', 15000, 'warn',
                'core area is not loaded around the bot (teleported away?); commands will retry once it is');
            return null;
        }

        // If we somehow lost track of liveness after the core has been
        // established, assume blocks are present and let writes/air-break
        // detection correct it. This keeps the core reusable.
        if (this.blocks.size === 0 && this.origin.x !== null && this.everReady) this.markAllAlive();
        // If every known block is marked dead, don't get stuck: assume alive and
        // let real failures/air breaks correct it.
        if (this.blocks.size > 0 && !this.survivor() && this.everReady) this.markAllAlive();

        for (let attempt = 0; attempt < this.volume; attempt++) {
            const cell = this.nextCell();
            if (!cell) return null;
            // Only skip blocks we positively know are dead.
            if (this.blocks.get(keyOf(cell)) === false) continue;

            this.markOwn(cell);
            const sent = this.bot.write
                ? this.bot.write('update_command_block', {
                    location: cell,
                    command: text.slice(0, 32000),
                    mode: this.blockMode(),
                    flags: 0b101
                })
                : false;

            if (sent !== false) {
                // Treat unknown blocks as alive once a write succeeds.
                if (!this.blocks.has(keyOf(cell))) this.blocks.set(keyOf(cell), true);
                else this.blocks.set(keyOf(cell), true);
                this.lastLocation = cell;
                return cell;
            }

            this.ownChanges.delete(keyOf(cell));
            this.blocks.set(keyOf(cell), false);
            this.logEvery('block-reject', 5000, 'debug', `core block ${cell.x} ${cell.y} ${cell.z} did not accept a command`);
        }

        // Last resort: request refill so the area can recover, then fail this
        // command (callers can retry on next tick). Avoid spamming forced refills.
        if (this.refillEnabled && Date.now() - (this.lastRefillAt || 0) > REFILL_MIN_INTERVAL_MS) {
            this.refill('run-fallback', { force: true });
        }
        this.logEvery('run-failed', 5000, 'warn', 'no core block accepted the command');
        return null;
    }

    // Listens for the reply to a block NBT query. The packet is called
    // nbt_query_response in every version from 1.16 to 1.21; the generic packet
    // hook is there in case a version renames it.
    bindClient(client) {
        if (!client || this.client === client) return;
        this.client = client;

        client.on('nbt_query_response', packet => this.onQueryResponse(packet));
        // A core can also be damaged in bulk: a chunk resend or a multi-block
        // update never fires block_change for each cell.
        client.on('map_chunk', packet => this.onMapChunk(packet));
        client.on('map_chunk_bulk', packet => this.onMapChunk(packet));
        client.on('multi_block_change', packet => this.onMultiBlockChange(packet));
        client.on('packet', (data, meta) => {
            const name = meta?.name || '';
            if (!/query.*nbt|nbt.*query/i.test(name)) return;
            this.onQueryResponse(data);
        });
    }

    onQueryResponse(packet) {
        if (!packet) return false;
        const pending = this.queries.get(packet.transactionId);
        if (!pending) return false;

        this.queries.delete(packet.transactionId);
        clearTimeout(pending.timer);
        pending.resolve(parseLastOutput(packet.nbt));
        return true;
    }

    // Runs a command in a core block and returns what the block printed, or null
    // if nothing answered. The block's output is only readable by asking the
    // server for the block's NBT, so a query follows the write.
    runTracked(command, { delay = 150, timeout = 3000 } = {}) {
        this.lastLocation = null;
        const cell = this.run(command);
        if (!cell) return Promise.resolve(null);

        const transactionId = this.queryId++;
        return new Promise(resolve => {
            // Both timers are ref'd on purpose: a caller awaiting the result must
            // keep the process alive until it arrives or times out.
            const timer = setTimeout(() => {
                this.queries.delete(transactionId);
                resolve(null);
            }, timeout);
            this.queries.set(transactionId, { resolve, timer });

            const ask = setTimeout(() => {
                const sent = this.bot.write
                    ? this.bot.write('query_block_nbt', { transactionId, location: cell })
                    : false;
                if (sent !== false) return;

                if (!this.queries.delete(transactionId)) return;
                clearTimeout(timer);
                resolve(null);
            }, delay);
        });
    }

    // The block as written in the fill command, with the configured name.
    // NBT text components changed in 1.21.5: a name used to be a JSON string
    // wrapped in quotes, and is now the component written inline.
    // update_command_block carries the block's own mode, so it has to match the
    // block: sending "repeating" for an impulse block fights its type.
    blockMode() {
        if (/repeating_command_block$/.test(this.block)) return 1;
        if (/chain_command_block$/.test(this.block)) return 0;
        return 2;
    }

    blockSpec() {
        if (!this.name) return this.block;
        if (!tellraw.isModern(this.bot?.client?.version)) {
            return `${this.block}{CustomName:'${this.name.replace(/'/g, "\\'")}'}`;
        }

        let component = this.name;
        try {
            component = JSON.parse(this.name);
        } catch {
            // Already SNBT; use it as written.
            return `${this.block}{CustomName:${this.name}}`;
        }
        return `${this.block}{CustomName:${tellraw.snbt(component)}}`;
    }

    markAllAlive() {
        if (this.origin.x === null) return;
        for (let x = this.origin.x; x <= this.bounds.x; x++) {
            for (let y = this.origin.y; y <= this.bounds.y; y++) {
                for (let z = this.origin.z; z <= this.bounds.z; z++) {
                    this.blocks.set(`${x}:${y}:${z}`, true);
                }
            }
        }
    }

    // Any block still standing can run the fill, so one is enough.
    survivor() {
        if (this.origin.x === null) return null;
        for (const [id, alive] of this.blocks) {
            if (!alive) continue;
            const [x, y, z] = id.split(':').map(Number);
            return { x, y, z };
        }
        return null;
    }

    nextCell() {
        if (this.origin.x === null) return null;
        const index = this.cursor++ % this.volume;
        const width = this.size;
        const area = width * width;

        const x = this.origin.x + (index % width);
        const y = this.origin.y + (Math.floor(index / width) % width);
        const z = this.origin.z + Math.floor(index / area);
        return { x, y, z };
    }

    inside(x, y, z) {
        if (this.origin.x === null) return false;
        const { origin, bounds } = this;
        x = Math.floor(Number(x)); y = Math.floor(Number(y)); z = Math.floor(Number(z));
        return x >= origin.x && x <= bounds.x &&
            y >= origin.y && y <= bounds.y &&
            z >= origin.z && z <= bounds.z;
    }

    markOwn(loc) {
        if (!loc) return;
        this.ownChanges.set(keyOf(loc), Date.now() + OWN_CHANGE_MS);
    }

    isOwn(loc) {
        if (!loc) return false;
        const key = keyOf(loc);
        const expires = this.ownChanges.get(key);
        if (!expires) return false;
        if (Date.now() >= expires) {
            this.ownChanges.delete(key);
            return false;
        }
        return true;
    }

    // prismarine-chunk is a native-format parser: one factory per version.
    chunkFactory() {
        const version = this.bot?.client?.version || this.bot?.version || null;
        if (!version) return null;
        if (this.chunkFactories.has(version)) return this.chunkFactories.get(version);
        let factory = null;
        try {
            // eslint-disable-next-line global-require
            factory = require('prismarine-chunk')(version);
        } catch {
            factory = null;
        }
        this.chunkFactories.set(version, factory);
        return factory;
    }

    // Chunk packet coordinates are chunk coordinates, so the core is only
    // affected by the one chunk it sits in.
    chunkMatches(x, z) {
        if (this.origin.x === null) return false;
        return Math.floor(this.origin.x / 16) === Number(x) &&
            Math.floor(this.origin.z / 16) === Number(z);
    }

    // Whatever a block turns out to be: any command block counts, because the
    // configured block can be repeating, chain or impulse.
    blockName(block) {
        return String(block?.name || block?.type || '').replace(/^minecraft:/, '');
    }

    // Bulk damage: a chunk resend replaces every block in the core at once.
    onMapChunk(packet) {
        if (!this.enabled || !this.refillEnabled) return false;
        if (!this.ready || this.refilling || Date.now() < this.graceUntil) return false;
        if (!packet || !this.chunkMatches(packet.x, packet.z)) return false;
        if (!packet.chunkData) return false;

        const Factory = this.chunkFactory();
        if (!Factory) return false;

        let chunk;
        try {
            chunk = new Factory();
            chunk.load(packet.chunkData, packet.bitMap || 0);
        } catch {
            return false; // unparsable chunk data is never damage
        }

        let damaged = 0;
        for (let x = this.origin.x; x <= this.bounds.x; x++) {
            for (let y = this.origin.y; y <= this.bounds.y; y++) {
                for (let z = this.origin.z; z <= this.bounds.z; z++) {
                    let name;
                    try {
                        const block = chunk.getBlock({ x: x & 15, y, z: z & 15 });
                        name = this.blockName(block);
                    } catch {
                        continue; // unknown block data: ignore, never damage
                    }
                    if (!name) continue;
                    const ours = name.includes('command_block');
                    this.blocks.set(keyOf({ x, y, z }), ours);
                    if (!ours) damaged += 1;
                }
            }
        }

        if (damaged >= 4) {
            this.lastChangeAt = Date.now();
            this.logEvery('chunk-damage', 10000, 'debug',
                `core chunk reload has ${damaged} non-command block(s); refilling`);
            this.refill('map_chunk_damage');
            return true;
        }
        return false;
    }

    // Bulk damage: a list of changed blocks in one packet.
    onMultiBlockChange(packet) {
        if (!this.enabled || !this.refillEnabled) return false;
        if (!this.ready || this.refilling || Date.now() < this.graceUntil) return false;
        if (!packet || !Array.isArray(packet.records)) return false;

        const section = packet.chunkCoordinates;
        if (!section || typeof section.x !== 'number') return false;
        if (!this.chunkMatches(section.x, section.z)) return false;

        let damaged = 0;
        for (const record of packet.records) {
            if (typeof record !== 'number') continue;
            // 1.16.2+ packs a section local position into the varint.
            const x = section.x * 16 + ((record >>> 8) & 0xF);
            const y = (Number(section.y) || 0) * 16 + (record & 0xF);
            const z = section.z * 16 + ((record >>> 4) & 0xF);
            if (!this.inside(x, y, z)) continue;
            if (this.isOwn({ x, y, z })) continue;
            this.blocks.set(keyOf({ x, y, z }), false);
            damaged += 1;
        }

        if (damaged > 0) {
            this.lastChangeAt = Date.now();
            this.logEvery('multi-block-damage', 10000, 'debug',
                `core multi-block update damaged ${damaged} block(s); refilling`);
            this.refill('multi_block_change');
            return true;
        }
        return false;
    }

    // Command blocks only tick in loaded chunks. If the bot has been teleported
    // (or the server dropped the chunk) a write is silently lost, so it is
    // better to refuse and let the caller retry.
    areaLoaded() {
        const position = this.bot?.position;
        if (!position || this.origin.x === null) return true; // cannot tell
        const centerX = this.origin.x + (this.size - 1) / 2;
        const centerZ = this.origin.z + (this.size - 1) / 2;
        const radius = this.size + 32;
        return Math.abs(position.x - centerX) <= radius &&
            Math.abs(position.z - centerZ) <= radius;
    }

    onReady() {
        if (!this.enabled) return;
        if (this.origin.x === null) this.reset();
        if (this.origin.x !== null) this.refill('startup');
        this.startWatchdog();
        // Spam refills run on their own only when explicitly turned on.
        if (this.config.refill?.auto === true) {
            setTimeout(() => {
                if (this.enabled && this.refillEnabled && this.origin.x !== null) this.startSpam();
            }, 1000).unref?.();
        }
    }

    // Nothing guarantees the fill landed: the bot may not be opped yet, a chunk
    // may not be loaded, or every block may have been broken. Every couple of
    // seconds, rebuild whatever is missing - through a leftover block when there
    // is one, and through chat when there is nothing left at all.
    startWatchdog() {
        if (this.watchdog || !this.enabled || !this.refillEnabled) return;
        this.watchdog = setInterval(() => {
            if (!this.enabled || this.refilling || this.spamTimer) return;
            if (this.origin.x === null && !this.reset()) return;

            const standing = this.aliveCount();
            // Only rebuild when the core is not usable. Readiness alone is not a
            // reason: a fill the server answered with "nothing changed" must not
            // keep the watchdog filling through chat forever.
            if (this.ready && standing > 0) return;

            // A server that keeps refusing needs backoff, not a fill every tick.
            if (standing === 0 && this.fillFailures >= 2 && Date.now() - (this.lastRefillAt || 0) < 10000) {
                return;
            }

            this.logEvery('watchdog-rebuild', 10000, 'debug',
                `core missing or incomplete (${standing} block(s) standing); rebuilding`);
            // Reuse a survivor when one is standing; with nothing left the fill
            // has to go through chat.
            this.refill('watchdog', { force: standing === 0, viaChat: standing === 0 });
        }, this.watchdogMs);
        this.watchdog.unref?.();
    }

    aliveCount() {
        let alive = 0;
        for (const value of this.blocks.values()) if (value) alive += 1;
        return alive;
    }

    // Core blocks can change often while commands are written into them.
    // Air is always a break. Other non-own changes may mean the block was
    // altered; treat as damage but coalesce repairs so heavy command traffic
    // (covered by own-change tracking) does not thrash refills.
    onBlockChange(packet) {
        // The bot's own block lives outside the area; if something changes it, the
        // next command places a new one.
        this.fillItem?.noteBlockChange(packet);
        if (!this.enabled || !this.refillEnabled) return false;
        const location = packet?.location;
        if (!location || this.origin.x === null) return false;
        if (!this.inside(location.x, location.y, location.z)) return false;
        this.lastChangeAt = Date.now();
        if (this.isOwn(location)) return false;
        // Only a core that is actually standing can be damaged. Reacting before
        // the first fill lands (or while a fill is in flight) turned the fill's
        // own updates into endless rebuilds.
        if (!this.ready || this.refilling || Date.now() < this.graceUntil) return false;

        const k = keyOf(location);

        // A core block that became air was broken outright: rebuild at once.
        if (isAir(packet)) {
            this.blocks.set(k, false);
            this.log.debug(`core block ${location.x} ${location.y} ${location.z} went to air; refilling`);
            this.refill('broken', { force: true });
            return true;
        }

        // External/non-own change: mark damaged and coalesce refill. Readiness
        // is deliberately left alone: the rest of the core still runs commands,
        // and a false "not ready" made every routed command fall back to chat.
        this.blocks.set(k, false);
        if (Date.now() - this.lastRefillAt < REFILL_MIN_INTERVAL_MS) return true;
        if (this.damageTimer) clearTimeout(this.damageTimer);
        this.damageTimer = setTimeout(() => {
            this.damageTimer = null;
            if (!this.enabled || !this.refillEnabled) return;
            this.refill(this.survivor() ? 'damaged' : 'broken', { force: !this.survivor() });
        }, DAMAGE_DELAY_MS);
        this.damageTimer.unref?.();
        return true;
    }

    destroy() {
        this.fillItem?.destroy();
        if (this.verifyTimer) {
            clearTimeout(this.verifyTimer);
            this.verifyTimer = null;
        }
        if (this.spamTimer) {
            clearInterval(this.spamTimer);
            this.spamTimer = null;
            this.spam = null;
        }
        for (const pending of this.queries.values()) {
            clearTimeout(pending.timer);
            pending.resolve(null);
        }
        this.queries.clear();
        this.client = null;
        if (this.damageTimer) {
            clearTimeout(this.damageTimer);
            this.damageTimer = null;
        }
        if (this.watchdog) {
            clearInterval(this.watchdog);
            this.watchdog = null;
        }
        this.ownChanges.clear();
        // A reconnect rebuilds the core: the old blocks may be gone, and a stale
        // "alive" map would send commands into nothing.
        this.blocks.clear();
        this.everReady = false;
        this.ready = false;
        this.refilling = false;
        this.lastFill = null;
        this.fillFailures = 0;
    }
}

function findKey(node, wanted) {
    if (!node || typeof node !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(node, wanted)) return node[wanted];
    for (const value of Object.values(node)) {
        const found = findKey(value, wanted);
        if (found !== undefined) return found;
    }
    return undefined;
}

// 1.20.2+ hands NBT over typed ({type, value}); older versions hand over plain
// objects. Both end up as plain JS here.
function simplifyNbt(node) {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(simplifyNbt);
    if (typeof node.type === 'string' && 'value' in node) {
        const value = node.value;
        if (node.type === 'compound') {
            const out = {};
            for (const key of Object.keys(value || {})) out[key] = simplifyNbt(value[key]);
            return out;
        }
        if (node.type === 'list') {
            const items = value && Array.isArray(value.value) ? value.value : [];
            const type = value && value.type;
            return items.map(item => (type === 'compound' && item && typeof item === 'object'
                ? simplifyNbt({ type: 'compound', value: item })
                : simplifyNbt(item)));
        }
        return value;
    }
    return node;
}

function flattenComponent(component) {
    if (component === null || component === undefined) return '';
    if (typeof component === 'string' || typeof component === 'number' || typeof component === 'boolean') {
        return String(component);
    }
    if (Array.isArray(component)) return component.map(flattenComponent).join('');

    let out = '';
    if (component.text !== undefined) out += flattenComponent(component.text);
    else if (component.translate !== undefined) {
        out += String(component.translate);
        const args = component.with || component.args;
        if (Array.isArray(args)) out += ' ' + args.map(flattenComponent).join(' ');
    }
    // A component wraps bare strings as { "": "text" }.
    if (component[''] !== undefined) out += flattenComponent(component['']);
    if (component.extra) out += flattenComponent(component.extra);
    return out;
}

// Pulls LastOutput out of the block's NBT and turns it into plain text.
function parseLastOutput(nbt) {
    const found = findKey(nbt, 'LastOutput');
    if (found === undefined) return null;

    let raw = simplifyNbt(found);
    if (typeof raw === 'string') {
        if (!raw) return null;
        try {
            raw = JSON.parse(raw);
        } catch {
            return raw;
        }
    }

    return flattenComponent(raw) || null;
}

function keyOf(loc) {
    if (!loc) return '';
    const x = Math.floor(Number(loc.x));
    const y = Math.floor(Number(loc.y));
    const z = Math.floor(Number(loc.z));
    return `${x}:${y}:${z}`;
}

// A block change packet carries either a block state number or, on servers that
// name blocks, the block itself. Air is state 0 in every version.
function isAir(packet) {
    const state = packet?.type ?? packet?.state ?? packet?.blockId;
    if (state === 0 || state === 'minecraft:air' || state === 'air') return true;
    const name = packet?.name ?? packet?.block;
    return name === 'minecraft:air' || name === 'air';
}

function positive(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = { Core };
