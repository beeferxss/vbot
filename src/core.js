'use strict';

// The core is a cube of command blocks. Commands are written into the blocks with
// the update_command_block packet, which keeps them off the chat log, and the
// area is refilled with /fill whenever something breaks a block.

const tellraw = require('./minecraft/tellraw');
const { flatten } = require('./minecraft/text');
const { MiniCore } = require('./minicore');

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

// A name as components, one per character, so it reads as a single word instead
// of a flat block of colour.
function namePartsFor(name) {
    if (!name) return [{ text: 'none', color: 'dark_gray' }];

    let component = name;
    try {
        component = JSON.parse(name);
    } catch {
        // A plain string name is perfectly valid.
    }

    const text = flatten(component);
    return text ? gradientParts(text) : [{ text: name, color: 'white' }];
}

const OWN_CHANGE_MS = 5000;
const DAMAGE_DELAY_MS = 250;
const REFILL_SETTLE_MS = 200;
const WATCHDOG_MS = 1000;
const DEFAULT_SPAM_MS = 150;
// The server kicks a client that sends too many packets. A punishment is a
// write into every block of the core, hundreds of them in one tick, so command
// writes are paced instead: a small burst at once, then this many per second.
// The writes that do not fit are simply retried by the caller's next cycle.
const DEFAULT_WRITE_RATE = 100;
const DEFAULT_WRITE_BURST = 20;
// A written command is not spent after one run: a repeating command block keeps
// running what it holds every tick. The command is therefore taken back out of
// the block again after it has had its ticks, or a burst leaves the whole core
// running forever - which melts the server and gets the bot kicked. Zero turns
// the clean-up off for a core that is meant to keep its commands.
const DEFAULT_COMMAND_TTL_MS = 500;
// A fill's own block updates can arrive a second or more later, and a refill
// twice in a row is never useful, so both the grace and the rate limit are
// generous. Without them one slow update looped refills forever.
const REFILL_GRACE_MS = 3000;
const REFILL_MIN_INTERVAL_MS = 1500;
// A command spends the block it ran in, so the area is filled again straight
// after it: long enough for the block to have run, short enough that the next
// command does not find a dead core.
const REFILL_AFTER_RUN_MS = 500;
// The refill after a command is the one worth doing promptly, so it is not held
// back by the full interval a damage refill is: two commands a second still get
// a fresh area without a fill for every keystroke.
const AFTER_RUN_MIN_MS = 750;
// A join puts the bot at the server's spawn, which is the one place the core
// must not be built: it is dropped somewhere random first - the same random
// spot the `rtp` command picks - and the fill waits until it has landed.
const JOIN_RTP_RANGE = 10000000;
const JOIN_RTP_HEIGHT = 100;
const JOIN_RTP_WAIT_MS = 6000;
const JOIN_POLL_MS = 100;
const JOIN_LANDED_DISTANCE = 8;
// Login and the first position packet are two packets; the core needs the
// position before it can place anything or teleport from anywhere.
const POSITION_RETRY_MS = 250;
const POSITION_RETRIES = 20;
// A block can be taken away without any block update at all: a WorldEdit fill, a
// /setblock from the console, a plugin. Nothing arrives to say so, so one block is
// asked about directly every few seconds - a query the server answers with the
// block's own NBT - and a cell that is no longer a command block is rebuilt.
const VERIFY_MS = 4000;
const VERIFY_TIMEOUT_MS = 2500;
const MINI_SETTLE_MS = 700;     // a fill needs a moment before it can be asked about
const PROBE_QUIET_MS = 60000;
// The last path when no block can run the fill or a command: plain chat. A fill
// is expensive enough to be worth one every few seconds, a command goes as soon
// as the one before it has had a tick to run.
const CHAT_FILL_MS = 5000;
const CHAT_RUN_MS = 250;

class Core {
    constructor({ bot, config, logger }) {
        this.bot = bot;
        this.log = logger;
        this.config = config || {};
        this.enabled = this.config.enabled !== false;

        this.size = positive(this.config.area?.size, 9);
        // The height every fill of the area lands on: underground, below what a
        // world is usually built on, so the cube is out of the way.
        this.y = Number.isFinite(Number(this.config.area?.y)) ? Number(this.config.area.y) : -30;
        // Repeating command blocks: a command keeps running in them, and a core
        // block can be created already holding one.
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
        // Set once the join has run its course for this connection: a position
        // packet that arrives late asks for a start again, and it must not
        // teleport or fill a second time.
        this.started = false;
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
        // Last block update inside the area that put a block *back*, rather than
        // taking one away. Breaking a core block sends air, so only this one
        // proves that a fill arrived.
        this.lastFillStateAt = 0;
        this.verifyTimer = null;
        this.watchdog = null;
        this.watchdogMs = positive(this.config.refill?.intervalMs, WATCHDOG_MS);
        // A burst of refills through the blocks, for when the area has to be back
        // now rather than eventually.
        this.spamTimer = null;
        this.spam = null;
        this.spamMs = positive(this.config.refill?.spamMs, DEFAULT_SPAM_MS);
        // Command-block writes are paced so a burst never reaches the server as
        // thousands of packets at once.
        this.writeRate = positive(this.config.refill?.writeRate, DEFAULT_WRITE_RATE);
        this.writeBurst = Math.max(1, positive(this.config.refill?.writeBurst, DEFAULT_WRITE_BURST));
        this.writeTokens = this.writeBurst;
        this.writeAt = Date.now();
        // cell -> timer that empties the command again once it has run.
        this.commandTtlMs = ttl(this.config.refill?.commandTtlMs, DEFAULT_COMMAND_TTL_MS);
        this.clearTimers = new Map();
        // Where a join teleport takes the bot before anything is built.
        this.joinRtp = null;
        const rtp = this.config.joinRtp;
        if (rtp !== false && rtp?.enabled !== false) {
            this.joinRtp = {
                range: positive(rtp?.range, JOIN_RTP_RANGE),
                height: positive(rtp?.height, JOIN_RTP_HEIGHT),
                waitMs: positive(rtp?.waitMs, JOIN_RTP_WAIT_MS)
            };
        }
        // Set while a join teleport is on its way: nothing is filled or placed
        // until the bot is where it is going to stay.
        this.joining = false;
        this.joinTarget = null;
        this.joinTimer = null;
        this.joinStartedAt = 0;
        this.positionTries = 0;
        // The bot's own command blocks: a small cube above its head that runs
        // the `/fill` rebuilding the main area when no core block is left to run
        // it. Commands never go into it.
        this.fillItem = this.config.refill?.item === false
            ? null
            : new MiniCore({
                bot,
                logger,
                config: { ...this.config.refill, block: this.block, name: this.config.refill?.miniName }
            });
        // A server that drops the fill - or one the bot cannot get a block into -
        // leaves nothing to write into. The last path is plain chat, rate-limited
        // so an ignored command cannot become a flood.
        this.chatFallback = this.config.refill?.chatFallback !== false;
        this.lastChatFillAt = 0;
        this.lastChatRunAt = 0;
        // Result the server reported for the last fill it ran for us.
        this.lastFill = null;
        this.fillFailures = 0;
        // Where the last command landed, and the queries waiting for an answer.
        this.lastLocation = null;
        this.client = null;
        this.queryId = 1;
        // Standing blocks being asked about directly, by transaction id. The
        // probes are numbered well clear of the run queries.
        this.probes = new Map();
        this.probeId = 1_000_000;
        this.probeTurn = 0;
        this.lastProbeAt = 0;
        this.probeMisses = 0;
        this.probeQuietUntil = 0;
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
        return namePartsFor(this.name);
    }

    // The mini core is what runs the ordinary commands (`get ip`, `seen`), so the
    // status `cb` and `core` print is its: the name it is filled with and where
    // the cube is. The main area is only refilled, never described here.
    miniStatusParts() {
        const mini = this.fillItem;
        if (!mini) return [{ text: 'the mini core is off in config', color: 'gray' }];

        const box = mini.current?.() || mini.box || null;
        if (!box) return [{ text: 'the mini core is not placed yet (no position seen)', color: 'gray' }];

        const standing = typeof mini.cells === 'function' ? mini.cells().length : 0;
        return [
            { text: 'mini core ', color: 'gray' },
            { text: `${mini.side}^3`, color: 'aqua' },
            { text: ` at ${box.min.x} ${box.min.y} ${box.min.z}..${box.max.x} ${box.max.y} ${box.max.z}, `, color: 'gray' },
            { text: `${standing}/${mini.count} standing`, color: standing ? 'green' : 'yellow' },
            { text: ', name ', color: 'dark_gray' },
            ...namePartsFor(mini.name)
        ];
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
        // Timers for cells of the area being left behind mean nothing here.
        this.clearPendingCommands();
        this.log.debug(`core area ${this.origin.x} ${this.origin.y} ${this.origin.z}`);
        return true;
    }

    // The fill goes through a block of the bot's own (the mini core) first, then
    // through whatever is left of the main core, and only then as chat: the bot
    // never places a block by hand, so this is how a core is built.
    refill(reason = 'manual', { force = false, minIntervalMs = REFILL_MIN_INTERVAL_MS } = {}) {
        if (!this.enabled || !this.refillEnabled) return false;
        // A join teleport is on its way: filling here would build the core at the
        // spawn the bot is leaving, so the area waits until it lands.
        if (this.joining) return false;
        if (this.origin.x === null && !this.reset()) return false;

        // Never refill on top of a refill: the block updates from the last fill
        // look like damage, and reacting to them loops forever.
        if (!force && this.refilling) return false;
        if (!force && Date.now() - this.lastRefillAt < minIntervalMs) {
            this.log.debug(`core refill (${reason}) skipped, last one was too recent`);
            return false;
        }

        const command = this.fillCommand();
        const mini = this.fillItem;

        let viaCore = false;
        let viaMini = false;        // the main fill went through one of the cube's own blocks
        let usedSurvivor = null;
        let viaChat = false;
        // Set when the cube was put down on this pass, which is a fill of its own.
        let built = false;
        let miniCell = null;

        // The cube is topped up first, whether none of it is standing or only some
        // of its cells are: a hole in the mini core heals instead of waiting for
        // the whole thing to be broken. It goes down through a core block that is
        // still standing, through one of its own blocks, or as chat.
        if (this.origin.x !== null && mini?.needsFill?.()) {
            const make = mini.fillCommand?.();
            if (make) {
                miniCell = this.writeIntoSurvivor(make) || mini.run(make);
                built = Boolean(miniCell);
                if (!built && this.chatFill(make, reason)) {
                    built = true;
                    viaChat = true;
                }
                if (built) this.verifyMiniFill();
            }
        }

        // Then the main core, through a block that is still standing - one other
        // than the cell the cube's fill just went into, which holds that command
        // now - a block of the cube, or as chat when nothing is left.
        // The cell that just took the cube's fill is held back for a moment: the
        // fill has to run before anything is written over it.
        if (miniCell) mini.busy?.(miniCell, 500);

        const used = miniCell ? new Set([keyOf(miniCell)]) : null;
        if (!viaChat) {
            if (mini && (usedSurvivor = mini.run(command))) {
                viaCore = true;
                viaMini = true;
            } else if ((usedSurvivor = this.writeIntoSurvivor(command, used))) {
                viaCore = true;
            } else if (built) {
                this.log.debug(`core refill (${reason}) put the mini core down; the area follows`);
            } else if (this.chatFill(command, reason)) {
                viaChat = true;
            } else {
                this.logEvery('refill-unavailable', 10000, 'warn',
                    `core refill (${reason}) has no block to run in; retrying shortly`);
            }
        }

        this.refilling = true;
        // Keep the core usable across rebuilds once it has worked at least once.
        if (!this.everReady) this.ready = false;
        // The fill itself produces a block change per cell; those are ours.
        this.graceUntil = Date.now() + REFILL_GRACE_MS;
        let place = 'nothing';
        if (viaMini) place = 'its own command block';
        else if (built && viaChat) place = 'chat, to put the mini core down';
        else if (built) place = 'a core block, to put the mini core down';
        else if (usedSurvivor) place = `block ${usedSurvivor.x} ${usedSurvivor.y} ${usedSurvivor.z}`;
        else if (viaChat) place = 'chat';
        if (reason === 'startup' || reason === 'manual' || reason === 'command') {
            this.log.info(`core refill (${reason}) via ${place}`);
        } else {
            this.log.debug(`core refill (${reason}) via ${place}`);
        }

        // A refill through the bot's own block cannot report failure: the write is
        // accepted even when the server drops it. Only a block update (or a block
        // query) at the cube says the fill landed.
        if (viaMini) this.verifyMiniFill();

        setTimeout(() => {
            this.refilling = false;
            this.ready = true;
            this.everReady = true;
            this.lastRefillAt = Date.now();
            this.markAllAlive();
        }, REFILL_SETTLE_MS).unref?.();

        return true;
    }

    // A fill that went into a block of its own, or a fill that was meant to put
    // the mini core down, is only real once the server says so at one of its cells.
    // Not every fill is announced cell by cell, so the bot asks instead: a command
    // block in the cube confirms all of it, because a fill is all or nothing.
    verifyMiniFill() {
        if (this.verifyTimer) clearTimeout(this.verifyTimer);
        this.verifyTimer = setTimeout(() => {
            this.verifyTimer = null;
            if (!this.enabled || this.bot?.destroyed) return;
            const mini = this.fillItem;
            if (!mini?.needsFill?.()) return;

            // A cell the fill was meant to put down is what it is asked about: a
            // cell that was already standing only says the cube was there before.
            const cell = mini.missingCells?.()[0] || mini.watchCells?.()[0];
            if (!cell) return this.miniFillLost();
            if (!this.probe('item', cell)) return this.miniFillLost();

            // The answer itself is the check; this only catches a server that never
            // answers. Blocks the core only believed were standing go with the
            // cube: writing a fill into one of those is how a fill is lost silently.
            this.verifyTimer = setTimeout(() => {
                this.verifyTimer = null;
                if (!this.fillItem?.needsFill?.()) return;
                this.miniFillLost();
            }, VERIFY_TIMEOUT_MS + 500);
            this.verifyTimer.unref?.();
        }, MINI_SETTLE_MS);
        this.verifyTimer.unref?.();
    }

    miniFillLost() {
        this.fillFailures += 1;
        const mini = this.fillItem;
        mini?.refused?.();

        // The fill went into a block that looked alive and was not: a bulk edit
        // takes the main core and the cube in one go, and a write into one of
        // those cells is accepted and lost. Chat is the one route that still
        // reaches the world with nothing standing, so the cube is asked for there
        // at once instead of waiting out the refusal.
        const again = mini?.fillCommand?.({ force: true });
        if (again && this.chatFill(again, 'mini core lost')) {
            mini?.recover?.();
            this.logEvery('mini-fill-chat', 10000, 'warn',
                'the mini core fill did not land; it went out as chat instead');
            return true;
        }

        this.logEvery('mini-fill-unconfirmed', 10000, 'warn',
            'the mini core fill did not land; the core is filled through a ' +
            'core block or chat instead');
        return false;
    }

    // Writes the fill into a core block that is still standing. That block only
    // holds one command at a time, so a cell is only used once per refill.
    writeIntoSurvivor(command, used = null) {
        if (this.refilling) return null;
        if (!this.everReady || this.origin.x === null) return null;
        for (const [id, alive] of this.blocks) {
            if (!alive) continue;
            if (used && used.has(id)) continue;
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
                this.scheduleClear(cell);
                return cell;
            }
            this.ownChanges.delete(keyOf(cell));
            this.blocks.set(keyOf(cell), false);
        }
        return null;
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

    // A command has just run in a core block, and the server may well have taken
    // the command back out of it, so the mini core fills the area again right
    // away instead of waiting for the damage to be noticed. Every command pushes
    // the wait back: a burst - a punishment loop, a scan - refills once when it
    // goes quiet instead of filling the area over commands that are still being
    // written.
    refillAfterRun(delay = REFILL_AFTER_RUN_MS) {
        if (!this.enabled || !this.refillEnabled) return null;
        // Nothing is filled while a join teleport is on its way: the bot is
        // about to leave this spot, and the area here is not the one to build.
        if (this.joining) return null;
        if (this.afterRunTimer) clearTimeout(this.afterRunTimer);
        const timer = setTimeout(() => {
            this.afterRunTimer = null;
            this.refill('after-run', { minIntervalMs: AFTER_RUN_MIN_MS });
        }, Math.max(Number(delay) || 0, 0));
        timer.unref?.();
        this.afterRunTimer = timer;
        return timer;
    }

    // Whether one command-block write may go out now. A burst is allowed, then
    // writes trickle at `writeRate` per second: a punishment loop that writes
    // every block of the core cannot turn into thousands of packets per tick,
    // which is what a server kicks for. A caller that gets false just tries
    // again on its next cycle, so nothing queues up.
    takeWrite() {
        const now = Date.now();
        const elapsed = Math.max(0, now - this.writeAt);
        this.writeAt = now;
        this.writeTokens = Math.min(
            this.writeBurst,
            this.writeTokens + (elapsed * this.writeRate) / 1000
        );
        if (this.writeTokens < 1) return false;
        this.writeTokens -= 1;
        return true;
    }

    // How many writes fit in a window of this size, so a caller that runs on a
    // timer can ask for a turn's worth instead of firing a whole core's worth
    // and having most of it refused.
    writesPer(windowMs = 50) {
        const ms = Math.max(0, Number(windowMs) || 0);
        return Math.max(1, Math.floor((this.writeRate * ms) / 1000));
    }

    // A repeating command block runs the command it holds every tick, so the
    // command has to be taken back out once it has had its ticks. This is what
    // keeps a burst from turning the core into a permanent command loop: the
    // packets stop when the burst does, and nothing keeps running behind it.
    scheduleClear(cell) {
        if (!this.commandTtlMs || !cell) return null;
        const key = keyOf(cell);
        const pending = this.clearTimers.get(key);
        if (pending) clearTimeout(pending);

        const timer = setTimeout(() => {
            this.clearTimers.delete(key);
            if (!this.enabled || this.bot?.destroyed) return;
            // The cell stays a command block; only its command goes. A write that
            // cannot go out is harmless - the next connection rebuilds the area.
            this.bot.write?.('update_command_block', {
                location: cell,
                command: '',
                mode: this.blockMode(),
                flags: 0b101
            });
        }, this.commandTtlMs);
        timer.unref?.();
        this.clearTimers.set(key, timer);
        return timer;
    }

    clearPendingCommands() {
        for (const timer of this.clearTimers.values()) clearTimeout(timer);
        this.clearTimers.clear();
    }

    // Spreads commands over the cube instead of hammering one block, so a
    // command never lands in the block that is currently executing. Destroyed
    // blocks are skipped, so a command is never written into nothing.
    // Every command goes into a core block with one `update_command_block`: the
    // packet is taken by the server wherever the bot is, so the block does not
    // have to be near it, and one write is one command. The mini core is not in
    // this path at all: it exists only to run the fills that rebuild the area.
    run(command) {
        if (!this.enabled) return null;
        const text = String(command || '').trim().replace(/^\//, '');
        if (!text) return null;

        if (this.origin.x === null && !this.reset()) return null;

        if (!this.areaLoaded()) {
            // A teleport (the join, a punishment, a world change) leaves the area
            // behind. Move the grid to where the bot stands and rebuild there
            // instead of refusing every command for the rest of the session; the
            // command goes into the new area on this same turn.
            if (!this.relocate('unloaded area')) return null;
        }

        // If we somehow lost track of liveness after the core has been
        // established, assume blocks are present and let writes/air-break
        // detection correct it. This keeps the core reusable.
        if (this.blocks.size === 0 && this.origin.x !== null && this.everReady) this.markAllAlive();
        // If every known block is marked dead, don't get stuck: assume alive and
        // let real failures/air breaks correct it.
        if (this.blocks.size > 0 && !this.survivor() && this.everReady) this.markAllAlive();

        // The mini core never takes a command: it is there to run the fills that
        // rebuild the main area, nothing else.

        if (!this.takeWrite()) {
            this.logEvery('core-paced', 5000, 'debug',
                'core writes are paced to keep the bot connected; retrying shortly');
            return null;
        }

        for (let attempt = 0; attempt < this.volume; attempt++) {
            const cell = this.nextCell();
            if (!cell) return null;
            // Only skip blocks we positively know are dead.
            if (this.blocks.get(keyOf(cell)) === false) continue;

            this.markOwn(cell);

            // A command written into a core block runs on the next tick: one
            // packet, no waiting for a block to be placed and created. The
            // server takes the packet wherever the bot is, so the block does not
            // have to be near it - which is what lets a burst like `filter` stay
            // one write per command.
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
                this.blocks.set(keyOf(cell), true);
                this.lastLocation = cell;
                this.scheduleClear(cell);
                this.refillAfterRun();
                return cell;
            }

            this.ownChanges.delete(keyOf(cell));
            this.blocks.set(keyOf(cell), false);
            this.logEvery('block-reject', 5000, 'debug', `core block ${cell.x} ${cell.y} ${cell.z} did not accept a command`);
        }

        // Nothing in the core took it. The command still has to run, so it goes
        // out as chat: this is what a server that drops the fill leaves the bot
        // with.
        const chatCell = this.chatRun(text);
        if (chatCell) {
            this.lastLocation = null;
            this.refillAfterRun();
            return chatCell;
        }

        // Last resort: request refill so the area can recover, then fail this
        // command (callers can retry on next tick). Avoid spamming forced refills.
        if (this.refillEnabled && Date.now() - (this.lastRefillAt || 0) > REFILL_MIN_INTERVAL_MS) {
            this.refill('run-fallback', { force: true });
        }
        this.logEvery('run-failed', 5000, 'warn', 'no core block accepted the command');
        return null;
    }

    // The fill as a plain chat command. Only reached when no block of the bot's
    // own and no surviving core block could take it, and only once every
    // CHAT_FILL_MS, so a server that ignores chat does not get one per retry.
    chatFill(command, reason = 'refill') {
        if (!this.chatFallback || this.joining) return false;
        if (typeof this.bot?.sendChat !== 'function') return false;
        const now = Date.now();
        if (now - this.lastChatFillAt < CHAT_FILL_MS) return false;
        if (!this.bot.sendChat(`/${command}`)) return false;
        this.lastChatFillAt = now;
        this.logEvery('chat-fill', CHAT_FILL_MS * 6, 'warn',
            `core refill (${reason}) had no block to run in; the fill went out as chat`);
        return true;
    }

    // The command as plain chat, for the same reason: the core could not take it.
    // Returns a cell-shaped marker so callers treat it as sent.
    chatRun(text) {
        if (!this.chatFallback) return null;
        if (typeof this.bot?.sendChat !== 'function') return null;
        const now = Date.now();
        if (now - this.lastChatRunAt < CHAT_RUN_MS) return null;
        if (!this.bot.sendChat(`/${text}`)) return null;
        this.lastChatRunAt = now;
        this.logEvery('chat-run', CHAT_RUN_MS * 20, 'warn',
            'no core block accepted the command; it went out as chat until one does');
        return { x: null, y: null, z: null, chat: true };
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

        const probe = this.probes.get(packet.transactionId);
        if (probe) {
            this.probes.delete(packet.transactionId);
            clearTimeout(probe.timer);
            return this.onProbeAnswer(probe, packet.nbt);
        }

        const pending = this.queries.get(packet.transactionId);
        if (!pending) return false;

        this.queries.delete(packet.transactionId);
        clearTimeout(pending.timer);
        pending.resolve(parseLastOutput(packet.nbt));
        return true;
    }

    // One cell of each kind is asked about directly, once every few seconds. The
    // answer is treated exactly like a block update: a command block says so, and
    // a cell that has been emptied or replaced says something else, which no block
    // update ever announced. The mini core and the main area are both checked,
    // because one silent deletion usually takes both.
    probeBlocks() {
        if (!this.enabled || !this.refillEnabled) return false;
        if (!this.ready || this.refilling || this.spamTimer || this.joining) return false;
        // A cell that is too far away answers as if it were empty, which is not
        // damage: nothing is asked about until the bot is back with its core.
        if (!this.areaLoaded()) return false;
        if (Date.now() < this.graceUntil || Date.now() < this.probeQuietUntil) return false;
        if (Date.now() - (this.lastProbeAt || 0) < VERIFY_MS) return false;
        this.lastProbeAt = Date.now();

        // A cube that was just filled but never answered is asked about too: the
        // answer is the only way its cells become usable.
        const mini = this.fillItem?.watchCells?.() || this.fillItem?.cells?.() || [];
        if (mini.length) this.probe('item', mini[this.probeTurn % mini.length]);

        const alive = [];
        for (const [id, live] of this.blocks) {
            if (!live) continue;
            const [x, y, z] = id.split(':').map(Number);
            alive.push({ x, y, z });
        }
        if (alive.length) this.probe('core', alive[this.probeTurn % alive.length]);

        this.probeTurn += 1;
        return mini.length > 0 || alive.length > 0;
    }

    // Asks the server what is at a cell. Only the answer says, and it arrives as an
    // nbt_query_response, which onProbeAnswer handles.
    probe(kind, cell) {
        if (!this.bot?.write) return false;
        const transactionId = this.probeId++;
        const sent = this.bot.write('query_block_nbt', {
            transactionId,
            location: { x: cell.x, y: cell.y, z: cell.z }
        });
        if (sent === false) return false;

        const timer = setTimeout(() => {
            this.probes.delete(transactionId);
            this.probeMisses += 1;
            // A server that does not answer - a bot that is not op, a plugin that
            // swallows the query - is left alone for a while rather than asked
            // over and over; block updates still cover everything else.
            if (this.probeMisses >= 2) {
                this.probeQuietUntil = Date.now() + PROBE_QUIET_MS;
                this.logEvery('probe-silent', PROBE_QUIET_MS, 'debug',
                    'the server does not answer block queries; deletions that send no block update cannot be seen');
            }
        }, VERIFY_TIMEOUT_MS);
        timer.unref?.();

        this.probes.set(transactionId, {
            kind,
            cell: { x: cell.x, y: cell.y, z: cell.z },
            timer
        });
        return true;
    }

    onProbeAnswer(probe, nbt) {
        this.probeMisses = 0;
        const ours = blockEntityId(nbt).includes('command_block');

        if (probe.kind === 'core') {
            this.blocks.set(keyOf(probe.cell), ours);
            if (ours) return true;
            this.log.debug(
                `core block ${probe.cell.x} ${probe.cell.y} ${probe.cell.z} is not there any more; refilling`
            );
            this.refill('probe', { force: true });
            return true;
        }

        if (ours) {
            // A fill is all or nothing: one cell standing means the cube is there.
            if (this.fillItem?.confirmAll) this.fillItem.confirmAll();
            else this.fillItem?.confirm?.(probe.cell);
            return true;
        }
        const dropped = this.fillItem?.goneAll?.() || 0;
        if (dropped) {
            this.log.debug(
                `the mini core at ${probe.cell.x} ${probe.cell.y} ${probe.cell.z} is gone ` +
                `(${dropped} block(s)); the next command places it again`
            );
        }
        return true;
    }

    // Runs a command in a core block and returns what the block printed, or null
    // if nothing answered. The block's output is only readable by asking the
    // server for the block's NBT, so a query follows the write.
    runTracked(command, { delay = null, timeout = 3000 } = {}) {
        this.lastLocation = null;
        const cell = this.run(command);
        if (!cell) return Promise.resolve(null);

        // The refill run() has just queued waits for the output to be read: it
        // would put a fresh command in the block before the query could answer.
        if (this.afterRunTimer) {
            clearTimeout(this.afterRunTimer);
            this.afterRunTimer = null;
        }

        // The write is one packet into a core block that already stands, so the
        // query follows it almost at once; a caller can still ask for longer.
        const wait = delay ?? 150;

        const transactionId = this.queryId++;
        return new Promise(resolve => {
            // Whatever happens, the area is filled again once the block has been
            // read: the command in it has run by then.
            const settle = output => {
                this.refillAfterRun(0);
                resolve(output);
            };
            // Both timers are ref'd on purpose: a caller awaiting the result must
            // keep the process alive until it arrives or times out.
            const timer = setTimeout(() => {
                this.queries.delete(transactionId);
                settle(null);
            }, timeout);
            this.queries.set(transactionId, { resolve: settle, timer });

            const ask = setTimeout(() => {
                const sent = this.bot.write
                    ? this.bot.write('query_block_nbt', { transactionId, location: cell })
                    : false;
                if (sent !== false) return;

                if (!this.queries.delete(transactionId)) return;
                clearTimeout(timer);
                settle(null);
            }, wait);
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

    // Bulk damage: a chunk resend replaces every block in the core at once, and it
    // is also the only thing a bulk edit says about the mini core when it sends no
    // block update for each cell.
    onMapChunk(packet) {
        if (!this.enabled || !this.refillEnabled) return false;
        if (!this.ready || this.refilling || Date.now() < this.graceUntil) return false;
        if (!packet || !packet.chunkData) return false;

        const chunkX = Number(packet.x);
        const chunkZ = Number(packet.z);
        const mini = (this.fillItem?.cells?.() || []).filter(
            cell => (cell.x >> 4) === chunkX && (cell.z >> 4) === chunkZ
        );
        const ours = this.chunkMatches(chunkX, chunkZ);
        if (!ours && !mini.length) return false;

        const Factory = this.chunkFactory();
        if (!Factory) return false;

        let chunk;
        try {
            chunk = new Factory();
            chunk.load(packet.chunkData, packet.bitMap || 0);
        } catch {
            return false; // unparsable chunk data is never damage
        }

        // A mini core block that the resent section no longer has is gone: the cell
        // is used again by the next command, which places a fresh block there.
        let dropped = 0;
        for (const cell of mini) {
            let name;
            try {
                name = this.blockName(chunk.getBlock({ x: cell.x & 15, y: cell.y, z: cell.z & 15 }));
            } catch {
                continue; // unknown block data: ignore, never drop a block over it
            }
            if (!name || name.includes('command_block')) continue;
            if (this.fillItem.gone(cell)) dropped += 1;
        }
        if (dropped > 0) {
            this.logEvery('mini-chunk-damage', 10000, 'debug',
                `a chunk resend left out ${dropped} mini core block(s); they are placed again`);
        }

        if (!ours) return dropped > 0;

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
        return dropped > 0;
    }

    // Bulk damage: a list of changed blocks in one packet. It is also how the
    // answer to a /fill arrives: a fill of 27 blocks comes back as one of these,
    // not as a block update per cell.
    onMultiBlockChange(packet) {
        if (!packet || !Array.isArray(packet.records)) return false;
        const section = packet.chunkCoordinates;
        if (!section || typeof section.x !== 'number') return false;

        const changes = [];
        for (const record of packet.records) {
            if (typeof record !== 'number') continue;
            // 1.16.2+ packs a section local position into the varint, and the
            // block state above the position bits.
            changes.push({
                x: section.x * 16 + ((record >>> 8) & 0xF),
                y: (Number(section.y) || 0) * 16 + (record & 0xF),
                z: section.z * 16 + ((record >>> 4) & 0xF),
                state: record >>> 12
            });
        }

        // The mini core sits above the bot, often in another section: its cells are
        // read first and whatever else the packet says is ignored for them. This
        // runs even mid-refill, because the refill is what put them there.
        let dropped = 0;
        const noted = new Set();
        for (const change of changes) {
            if (this.fillItem?.noteBlockChange?.({ location: { x: change.x, y: change.y, z: change.z }, type: change.state })) {
                dropped += 1;
                noted.add(`${change.x}:${change.y}:${change.z}`);
            }
        }

        if (!this.enabled || !this.refillEnabled) return dropped > 0;
        // A bulk edit that took part of the cube is healed before anything else.
        if (dropped > 0 && this.fillItem?.needsFill?.()) this.refill('mini core damaged');
        if (!this.ready || this.refilling || Date.now() < this.graceUntil) return dropped > 0;

        let damaged = 0;
        for (const change of changes) {
            if (noted.has(`${change.x}:${change.y}:${change.z}`)) continue;
            // A cell of the cube the server has not shown yet: it is not the main
            // area's business either way.
            if (this.fillItem?.inBox?.(change)) continue;
            if (!this.inside(change.x, change.y, change.z)) continue;
            if (this.isOwn(change)) continue;
            this.blocks.set(keyOf(change), false);
            damaged += 1;
        }

        if (dropped > 0) {
            this.logEvery('mini-block-damage', 10000, 'debug',
                `a bulk update removed ${dropped} mini core block(s); they are filled again`);
        }
        if (damaged > 0) {
            this.lastChangeAt = Date.now();
            this.logEvery('multi-block-damage', 10000, 'debug',
                `core multi-block update damaged ${damaged} block(s); refilling`);
            this.refill('multi_block_change');
            return true;
        }
        return dropped > 0;
    }

    // The bot is somewhere other than the area the core was built in: a join, a
    // punishment teleport, a world change. The grid moves to where it stands now
    // and the old area is forgotten, so the core heals instead of being stuck
    // "unloaded" for the whole session.
    relocate(reason = 'moved') {
        if (!this.enabled || this.joining || this.bot?.destroyed) return false;
        const position = this.bot?.position;
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return false;

        const before = this.origin.x === null ? null : `${this.origin.x}:${this.origin.z}`;
        if (!this.reset(position)) return false;
        if (before === `${this.origin.x}:${this.origin.z}`) return false;

        this.logEvery('core-moved', 10000, 'debug',
            `core moved to ${this.origin.x} ${this.origin.z} (${reason})`);
        this.refill('moved', { force: true });
        return true;
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
        if (this.started) return;
        if (this.joining) return;
        if (this.bot?.destroyed) return;

        // Nothing is placed before the bot is somewhere: no position means no
        // core area and nowhere to teleport from, and the packet is a moment
        // behind the login one.
        if (!this.bot?.position) {
            // The position packet is a moment behind the login one, and on some
            // servers a lot more than that: a queue, a proxy, a slow world. The
            // core keeps waiting for it instead of giving up for the rest of the
            // session, which would leave the bot with no fill and no commands.
            this.positionTries += 1;
            const late = this.positionTries > POSITION_RETRIES;
            const timer = setTimeout(
                () => this.onReady(),
                late ? POSITION_RETRY_MS * 8 : POSITION_RETRY_MS
            );
            timer.unref?.();
            if (late) {
                this.logEvery('core-no-position', 60000, 'warn',
                    'the server has not sent a position yet; the core starts as soon as it does');
            }
            return;
        }
        this.positionTries = 0;

        if (this.startJoinRtp()) return;
        this.begin();
    }

    // What a join does once the bot is where it belongs: the area is filled, the
    // watchdog keeps it filled and the spam refill starts when it was asked to.
    begin() {
        this.started = true;
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

    // The random teleport a join starts with, through the bot's own blocks like
    // any other command. Returns false when there is nothing to wait for, so the
    // join goes straight on to the fill.
    startJoinRtp() {
        if (!this.joinRtp) return false;
        if (!this.bot?.position) return false;
        const username = this.bot?.server?.username;
        if (!username) return false;
        // The core belongs where the bot is now, not where it was on an earlier
        // join, so the area starts over from the position just seen.
        if (!this.reset()) return false;

        const { range, height, waitMs } = this.joinRtp;
        const target = {
            x: Math.floor(Math.random() * range),
            y: height,
            z: Math.floor(Math.random() * range)
        };

        this.joining = true;
        this.joinTarget = target;
        this.joinStartedAt = Date.now();
        const cell = this.run(`tp ${username} ${target.x} ${target.y} ${target.z}`);
        if (!cell) {
            // Nothing could run the teleport: build where the bot stands.
            this.joining = false;
            this.joinTarget = null;
            return false;
        }

        this.log.debug(`join teleport to ${target.x} ${target.y} ${target.z}`);
        const check = () => {
            this.joinTimer = null;
            const position = this.bot?.position;
            const landed = Boolean(position)
                && Math.hypot(position.x - target.x, position.z - target.z) <= JOIN_LANDED_DISTANCE;
            if (!landed && this.joining && !this.bot?.destroyed && Date.now() - this.joinStartedAt < waitMs) {
                this.joinTimer = setTimeout(check, JOIN_POLL_MS);
                this.joinTimer.unref?.();
                return;
            }
            this.settleJoin(landed);
        };
        this.joinTimer = setTimeout(check, JOIN_POLL_MS);
        this.joinTimer.unref?.();
        return true;
    }

    // The teleport is over: the core is built here, and the blocks the join wrote
    // at the old spot are cleared. A repeating block still holding `tp` would drag
    // the bot back every tick for as long as it stood.
    settleJoin(landed) {
        this.joining = false;
        this.joinTimer = null;
        this.joinTarget = null;
        // The cells this join wrote, before the old area is forgotten: the core
        // cells, and the mini core's own blocks that create them.
        const written = [...this.blocks.keys()].map(id => id.split(':').map(Number));
        const mini = this.fillItem?.cells?.() || [];

        if (!landed) {
            this.logEvery('join-rtp', 60000, 'debug',
                'the join teleport has not landed; the core is built where the bot stands');
        }

        // Everything known about the old spot is dropped with it: the area, the
        // blocks and the command cursor all start again from the new position.
        this.blocks.clear();
        this.everReady = false;
        this.ready = false;
        this.refilling = false;
        this.cursor = 0;
        this.origin = { x: null, y: this.y, z: null };
        this.bounds = { x: null, y: this.y + this.size - 1, z: null };
        this.begin();

        // One command clears each of them, from the core that is here now. A
        // cell inside the new area was already replaced by the fill, and the
        // mini core's own blocks go first: they are what re-creates the core cell
        // holding the teleport, every tick, until they are gone.
        if (!landed) return;
        const cells = [...mini, ...written.map(([x, y, z]) => ({ x, y, z }))];
        for (const cell of cells) {
            if (this.inside(cell.x, cell.y, cell.z)) continue;
            this.run(`setblock ${Math.floor(cell.x)} ${Math.floor(cell.y)} ${Math.floor(cell.z)} minecraft:air`);
        }
    }

    // The whole area goes away in one fill of air, through a block when one is
    // standing and as chat when none is. Used by the stop command, after the mini
    // core's own blocks - those recreate core cells every tick - are gone.
    clear() {
        const { origin, bounds } = this;
        if (origin.x === null) return false;
        const command = `fill ${origin.x} ${origin.y} ${origin.z} ` +
            `${bounds.x} ${bounds.y} ${bounds.z} minecraft:air`;
        const written = this.run(command);
        if (!written) this.chatRun(command);
        this.blocks.clear();
        this.ready = false;
        this.everReady = false;
        return true;
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
            if (!this.areaLoaded()) {
                this.relocate('watchdog');
                return;
            }

            // Blocks that were taken away without a block update are only found by
            // asking, so one of them is asked about on every tick that is due.
            this.probeBlocks();

            const standing = this.aliveCount();
            // Only rebuild when the core is not usable. Readiness alone is not a
            // reason: a fill the server answered with "nothing changed" must not
            // keep the watchdog filling through chat forever. A cube with a hole in
            // it is a reason: it is topped up where it stands.
            if (this.ready && standing > 0 && !this.fillItem?.needsFill?.()) return;

            // A server that keeps refusing needs backoff, not a fill every tick.
            if (standing === 0 && this.fillFailures >= 2 && Date.now() - (this.lastRefillAt || 0) < 10000) {
                return;
            }

            this.logEvery('watchdog-rebuild', 10000, 'debug',
                `core missing or incomplete (${standing} block(s) standing); rebuilding`);
            // Reuse a survivor when one is standing; with nothing left the fill
            // has to go through chat.
            this.refill('watchdog', { force: standing === 0 });
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
        const miniLost = this.fillItem?.noteBlockChange?.(packet);
        if (!this.enabled || !this.refillEnabled) return false;
        // The cube is filled again where it stands, whether all of it went or only
        // the cell this update is about.
        if (miniLost && this.fillItem?.needsFill?.()) this.refill('mini core damaged');
        const location = packet?.location;
        if (!location || this.origin.x === null) return false;
        if (!this.inside(location.x, location.y, location.z)) return false;
        this.lastChangeAt = Date.now();
        if (!isAir(packet)) this.lastFillStateAt = Date.now();
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
        // A reconnect starts over: the next join is a fresh start.
        this.started = false;
        this.positionTries = 0;
        this.fillItem?.destroy();
        if (this.joinTimer) {
            clearTimeout(this.joinTimer);
            this.joinTimer = null;
        }
        this.joining = false;
        this.joinTarget = null;
        this.positionTries = 0;
        if (this.afterRunTimer) {
            clearTimeout(this.afterRunTimer);
            this.afterRunTimer = null;
        }
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
        for (const probe of this.probes.values()) clearTimeout(probe.timer);
        this.probes.clear();
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
        // Nothing may write after the connection that could carry it is gone.
        this.clearPendingCommands();
        // A reconnect rebuilds the core: the old blocks may be gone, and a stale
        // "alive" map would send commands into nothing. The grid starts over from
        // the position the next connection reports, never the one left behind.
        this.blocks.clear();
        this.everReady = false;
        this.ready = false;
        this.refilling = false;
        this.origin = { x: null, y: this.y, z: null };
        this.bounds = { x: null, y: this.y + this.size - 1, z: null };
        this.cursor = 0;
        this.writeTokens = this.writeBurst;
        this.writeAt = Date.now();
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
// The block entity id from a query answer: 'minecraft:command_block' for one of
// ours. A cell that is now air, or a block without a block entity, answers with
// nothing at all, which is the only sign a silent deletion ever gives.
function blockEntityId(nbt) {
    if (!nbt || typeof nbt !== 'object') return '';
    const value = nbt.type === 'compound' && nbt.value ? nbt.value : nbt;
    const id = value && typeof value === 'object' ? value.id : undefined;
    const name = simplifyNbt(id);
    if (typeof name === 'string' && name) return name;

    // Newer servers (26.x) answer with the block entity's own fields and no id at
    // all. Of the block entities the core ever asks about, only a command block
    // carries a command: that is what makes the answer recognisable.
    if (value && typeof value === 'object'
        && value.Command !== undefined
        && (value.auto !== undefined || value.TrackOutput !== undefined
            || value.SuccessCount !== undefined || value.UpdateLastExecution !== undefined)) {
        return 'minecraft:command_block';
    }
    return '';
}

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

// Like positive(), but zero is a real value: it turns the clean-up off.
function ttl(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

module.exports = { Core };
