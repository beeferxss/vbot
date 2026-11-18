'use strict';

// Where a punished player is put: the overworld floor, below anything that can be
// built on, so their client has no chunks to stand in.
//
// The height that was asked for is the integer minimum, y = -2147483647. A stock
// Paper core refuses it - `/tp` answers "Invalid position for teleport" for
// anything below -20000000, spectator or not - so the deepest height a server
// takes goes in as well, and the minimum is sent straight after it. A core that
// takes the minimum keeps it; one that refuses it stays where the other line put
// the player.

const MIN_VOID_Y = -2147483647;
const DEFAULT_VOID_Y = -20000000;
const MAX_Y = 20000000;

// The height to teleport to, clamped to what a position can hold at all.
function voidY(value) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return DEFAULT_VOID_Y;
    return Math.max(MIN_VOID_Y, Math.min(number, MAX_Y));
}

// No `execute in ...` on the front: the Kaboom core refuses every one of them
// (its execute_vanilla_only patch leaves `run` unable to take a command, and it
// answers nothing at all), so a wrapped teleport is a no-op there. The plain
// command goes to the source's dimension, and the command blocks are in the
// bot's world, so the player still lands in the overworld. `minecraft:` keeps a
// server's own /tp (Essentials has one, which caps coordinates at 30000000) out
// of the way.
function voidCommand(name, { y = DEFAULT_VOID_Y, x = 0, z = 0 } = {}) {
    const target = String(name || '').trim();
    if (!target) return null;
    const at = [Math.floor(Number(x) || 0), voidY(y), Math.floor(Number(z) || 0)];
    return `minecraft:tp ${target} ${at[0]} ${at[1]} ${at[2]}`;
}

// Where they come back after a death. A teleport alone does not hold: the void
// kills them and they respawn at spawn, back in the game. Setting their spawn
// point in the void too means every death puts them there again, so the
// punishment outlasts the session as well - the point is saved with the player.
function voidSpawnCommand(name, { y = DEFAULT_VOID_Y, x = 0, z = 0 } = {}) {
    const target = String(name || '').trim();
    if (!target) return null;
    const at = [Math.floor(Number(x) || 0), voidY(y), Math.floor(Number(z) || 0)];
    return `minecraft:spawnpoint ${target} ${at[0]} ${at[1]} ${at[2]}`;
}

// The deepest height the server takes, then the minimum. A command block
// reports a refusal to nearby operators rather than to the log, so the refused
// line costs nothing, and a server configured for the minimum (voidY) gets one
// line instead of two.
function voidCommands(name, { y = DEFAULT_VOID_Y, x = 0, z = 0 } = {}) {
    const lines = [voidCommand(name, { y, x, z })];
    if (voidY(y) !== MIN_VOID_Y) lines.push(voidCommand(name, { y: MIN_VOID_Y, x, z }));
    return lines.filter(Boolean);
}

function voidSpawnCommands(name, { y = DEFAULT_VOID_Y, x = 0, z = 0 } = {}) {
    const lines = [voidSpawnCommand(name, { y, x, z })];
    if (voidY(y) !== MIN_VOID_Y) lines.push(voidSpawnCommand(name, { y: MIN_VOID_Y, x, z }));
    return lines.filter(Boolean);
}

module.exports = {
    voidCommand,
    voidSpawnCommand,
    voidCommands,
    voidSpawnCommands,
    voidY,
    DEFAULT_VOID_Y,
    MIN_VOID_Y
};
