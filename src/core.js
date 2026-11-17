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
const PROBE_QUIET_MS = 60000;

class Core {
    constructor({ bot, config, logger }) {
        this.bot = bot;
        this.log = logger;
        this.config = config || {};
        this.enabled = this.config.enabled !== false;

        this.size = positive(this.config.area?.size, 9);
        this.y = Number.isFinite(Number(this.config.area?.y)) ? Number(this.config.area.y) : 64;
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
        // The bot's own command blocks, spread around it: everything is written
        // into them and they run against the main core.
        this.fillItem = this.config.refill?.item === false
            ? null
            : new FillItem({
                bot,
                logger,
                config: this.config.refill,
                // Its own fill would replace the blocks, so keep them out of the area
                // whenever a side of the bot allows it.
                avoid: (cell) => Boolean(this.origin) && this.origin.x !== null && this.inside(cell.x, cell.y, cell.z)
            });
        this.itemFills = 0;
        // Whether the last command went in through the mini core, which adds a
        // round trip before the core block exists.
        this.lastViaItem = false;
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

    // The fill always goes through the bot's own command blocks: nothing is sent
    // as chat. A surviving core block is the second choice, and when neither can
    // run it the watchdog retries instead of talking to the server.
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

        // The bot's own command blocks come first: they are the mini core, so a
        // refill only replaces the command inside one of them and that block
        // fills the main core itself. Its own blocks are never written to
        // directly.
        let viaCore = false;
        let viaItem = false;
        let usedSurvivor = null;
        // Forced refills are allowed on top of a fill still in flight: the bot's
        // block only has its command replaced, so nothing is placed twice.
        if (this.origin.x !== null) {
            viaItem = Boolean(this.placeFill(command));
            viaCore = viaItem;
        }

        // Whatever is left of the main core refills it when there is no block of
        // the bot's own: writing the fill into a surviving block needs no item.
        if (!viaCore && !this.refilling && this.everReady && this.origin.x !== null) {
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

        if (!viaCore) {
            // Nothing can run the fill right now (no mini core, no survivor). The
            // watchdog retries; chat is never used.
            this.logEvery('refill-unavailable', 10000, 'warn',
                `core refill (${reason}) has no block to run in; retrying shortly`);
        }

        this.refilling = true;
        // Keep the core usable across rebuilds once it has worked at least once.
        if (!this.everReady) this.ready = false;
        // The fill itself produces a block change per cell; those are ours.
        this.graceUntil = Date.now() + REFILL_GRACE_MS;
        let place = 'nothing';
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

    verifyItemFill(command) {
        if (this.verifyTimer) clearTimeout(this.verifyTimer);
        const startedAt = Date.now();
        // A refill that had to place the block first is later than one written
        // into a block that was already standing, so give it the extra time.
        const placing = this.fillItem?.pending ? 1500 : 0;
        const wait = Math.max(700, (this.fillItem?.holdMs || 250) + 450, placing);
        this.verifyTimer = setTimeout(() => {
            this.verifyTimer = null;
            if (!this.enabled || this.bot.destroyed) return;
            // A block that came back inside the area means the fill reached the
            // world. The damage that started the refill is air, so it does not
            // count, and a lost fill still falls back to chat.
            if (this.lastFillStateAt >= startedAt) return;
            this.fillFailures += 1;
            this.logEvery('item-fill-unconfirmed', 10000, 'warn',
                "the bot's command block did not fill the core (placement refused?); retrying through the core");
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

    // What the mini core is told to do with one core cell: clear it, then create
    // it holding the command and `auto`, so a repeating core block starts running
    // the command without redstone. The cell is cleared first so the block is
    // always created fresh instead of written into whatever stands there.
    cellCommands(cell, command) {
        const at = `${cell.x} ${cell.y} ${cell.z}`;
        return [
            `setblock ${at} minecraft:air`,
            `setblock ${at} ${this.block}{Command:"${snbtQuote(command)}",auto:1b,TrackOutput:1b} replace`
        ];
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

    // Spreads commands over the cube instead of hammering one block, so a
    // command never lands in the block that is currently executing. Destroyed
    // blocks are skipped, so a command is never written into nothing.
    run(command) {
        if (!this.enabled) return null;
        const text = String(command || '').trim().replace(/^\//, '');
        if (!text) return null;

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

            // A cell that already holds a core block is the normal core, and a
            // command written into it runs on the next tick: one packet, no
            // waiting for a block to be placed and created. That is the path a
            // burst like `filter` needs, and the mini core is not in it.
            const live = this.blocks.get(keyOf(cell)) === true;
            if (live && this.bot.write) {
                const sent = this.bot.write('update_command_block', {
                    location: cell,
                    command: text.slice(0, 32000),
                    mode: this.blockMode(),
                    flags: 0b101
                });
                if (sent !== false) {
                    this.lastLocation = cell;
                    this.lastViaItem = false;
                    this.refillAfterRun();
                    return cell;
                }
            }

            // Nothing stands in this cell yet: the mini core does not run the
            // command itself, it writes the core block with the command and `auto`
            // already in it, so the block that executes is a real core block.
            if (this.fillItem?.usable) {
                const own = this.fillItem.run(this.cellCommands(cell, text));
                if (own) {
                    this.blocks.set(keyOf(cell), true);
                    this.lastLocation = cell;
                    this.lastViaItem = true;
                    this.refillAfterRun();
                    return cell;
                }
            }
            this.lastViaItem = false;

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
                this.refillAfterRun();
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

        const mini = this.fillItem?.cells?.() || [];
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
            this.fillItem?.confirm?.(probe.cell);
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

        // Through the mini core the core block is created by the wrapper it runs,
        // and a fresh mini block has to be placed before any of that can happen.
        const wait = delay ?? (this.lastViaItem
            ? (this.fillItem?.pendingCount ? 1500 : 600)
            : 150);

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

    // Bulk damage: a list of changed blocks in one packet.
    onMultiBlockChange(packet) {
        if (!this.enabled || !this.refillEnabled) return false;
        if (!this.ready || this.refilling || Date.now() < this.graceUntil) return false;
        if (!packet || !Array.isArray(packet.records)) return false;

        const section = packet.chunkCoordinates;
        if (!section || typeof section.x !== 'number') return false;

        // The mini core can sit in a neighbouring section, and the same packet says
        // what happened to it: a cell of it that turns to air is a block that is
        // gone without a block update of its own.
        const mini = new Map();
        for (const cell of this.fillItem?.cells?.() || []) mini.set(keyOf(cell), cell);

        let damaged = 0;
        let dropped = 0;
        for (const record of packet.records) {
            if (typeof record !== 'number') continue;
            // 1.16.2+ packs a section local position into the varint.
            const x = section.x * 16 + ((record >>> 8) & 0xF);
            const y = (Number(section.y) || 0) * 16 + (record & 0xF);
            const z = section.z * 16 + ((record >>> 4) & 0xF);
            const key = keyOf({ x, y, z });

            const mine = mini.get(key);
            if (mine) {
                // The block state sits above the position bits; anything that is not
                // a command block means that block is not there any more.
                if (!this.fillItem?.isOwnState?.(record >>> 12) && this.fillItem?.gone?.(mine)) {
                    dropped += 1;
                }
                continue;
            }

            if (!this.inside(x, y, z)) continue;
            if (this.isOwn({ x, y, z })) continue;
            this.blocks.set(key, false);
            damaged += 1;
        }

        if (dropped > 0) {
            this.logEvery('mini-block-damage', 10000, 'debug',
                `a bulk update removed ${dropped} mini core block(s); they are placed again`);
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
        if (this.joining) return;
        if (this.bot?.destroyed) return;

        // Nothing is placed before the bot is somewhere: no position means no
        // core area and nowhere to teleport from, and the packet is a moment
        // behind the login one.
        if (!this.bot?.position) {
            if (this.positionTries >= POSITION_RETRIES) {
                this.positionTries = 0;
                return;
            }
            this.positionTries += 1;
            const timer = setTimeout(() => this.onReady(), POSITION_RETRY_MS);
            timer.unref?.();
            return;
        }
        this.positionTries = 0;

        if (this.startJoinRtp()) return;
        this.begin();
    }

    // What a join does once the bot is where it belongs: the area is filled, the
    // watchdog keeps it filled and the spam refill starts when it was asked to.
    begin() {
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

    // Nothing guarantees the fill landed: the bot may not be opped yet, a chunk
    // may not be loaded, or every block may have been broken. Every couple of
    // seconds, rebuild whatever is missing - through a leftover block when there
    // is one, and through chat when there is nothing left at all.
    startWatchdog() {
        if (this.watchdog || !this.enabled || !this.refillEnabled) return;
        this.watchdog = setInterval(() => {
            if (!this.enabled || this.refilling || this.spamTimer) return;
            if (this.origin.x === null && !this.reset()) return;

            // Blocks that were taken away without a block update are only found by
            // asking, so one of them is asked about on every tick that is due.
            this.probeBlocks();

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
        this.fillItem?.noteBlockChange?.(packet);
        if (!this.enabled || !this.refillEnabled) return false;
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
// The block entity id from a query answer: 'minecraft:command_block' for one of
// ours. A cell that is now air, or a block without a block entity, answers with
// nothing at all, which is the only sign a silent deletion ever gives.
function blockEntityId(nbt) {
    if (!nbt || typeof nbt !== 'object') return '';
    const value = nbt.type === 'compound' && nbt.value ? nbt.value : nbt;
    const id = value && typeof value === 'object' ? value.id : undefined;
    const name = simplifyNbt(id);
    return typeof name === 'string' ? name : '';
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

// A command as an SNBT string: the quotes and backslashes a command may contain
// are escaped, and it stays one line. Long commands are cut before escaping so a
// half-written escape never reaches the server.
function snbtQuote(command) {
    return String(command ?? '')
        .slice(0, 15000)
        .replace(/[\r\n]+/g, ' ')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
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
