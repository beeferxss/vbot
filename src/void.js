'use strict';

// Where a punished player is put: the overworld floor, below anything that can be
// built on, so their client has no chunks to stand in.
//
// The idea is the integer minimum height, y = -2147483647: a client sent there is
// in the void for good. A stock server refuses it, though - `/tp` and `/summon`
// both answer "Invalid position" for anything below -20000000, even for a
// spectator - so that height only lands on a server patched to accept it (the
// Kaboom-style free-op servers), where `voidY` is set to it. Everywhere else the
// smallest height a server takes is what is used.

const MIN_VOID_Y = -2147483647;
const DEFAULT_VOID_Y = -20000000;
const MAX_Y = 20000000;

// The height to teleport to, clamped to what a position can hold at all.
function voidY(value) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return DEFAULT_VOID_Y;
    return Math.max(MIN_VOID_Y, Math.min(number, MAX_Y));
}

// `execute in ...` because the player may be in the nether or the end: the void
// they are sent to is the overworld's. A plain tp would leave them in the world
// they were already in.
function voidCommand(name, { y = DEFAULT_VOID_Y, x = 0, z = 0 } = {}) {
    const target = String(name || '').trim();
    if (!target) return null;
    const at = [Math.floor(Number(x) || 0), voidY(y), Math.floor(Number(z) || 0)];
    return `execute in minecraft:overworld run tp ${target} ${at[0]} ${at[1]} ${at[2]}`;
}

module.exports = { voidCommand, voidY, DEFAULT_VOID_Y, MIN_VOID_Y };
