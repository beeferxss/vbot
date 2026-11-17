'use strict';

// Random teleport, ported from the reference bot: the caller is dropped at a
// random spot in the world through the core, so it works without op.
const RANGE = 10000000;
const HEIGHT = 100;

module.exports = {
    name: 'rtp',
    description: 'Teleport yourself to a random spot far away',
    usage: 'rtp',
    level: 'public',

    async execute(ctx) {
        const target = ctx.username;
        if (!target) return ctx.reply('No target.');

        const x = Math.floor(Math.random() * RANGE);
        const z = Math.floor(Math.random() * RANGE);

        ctx.reply(`Teleporting ${target} to ${x} ${HEIGHT} ${z}`);
        ctx.run(`tp ${target} ${x} ${HEIGHT} ${z}`);
    }
};
