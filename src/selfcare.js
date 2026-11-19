'use strict';

// Keeps the bot in a usable state on free-op servers: it asks for op when it has
// none, stays in creative, keeps command spy and vanish on, and undoes a mute.
// Ported from the reference bot's selfcare plugin, told apart by what it can
// actually observe here: packets arrive through the Bot, and commands go through
// the core when it is up.

const RETRY_MS = 700;
const TICK_MS = 1500;
const OP_RETRY_MS = 5000;
// Not every server names the gamemode: no field in the login packet, none in the
// player list. Creative is still asked for, but with nothing to read back it is
// asked again only this often instead of on every tick.
const UNKNOWN_GAMEMODE_RETRY_MS = 15000;

// Both the vanilla wording and the plugin wordings the reference listens for.
const MUTED_LINES = [
    'you have been muted!',
    'your voice has been silenced!'
];
const UNMUTED_LINES = [
    'you have been muted for now.',
    'you can now talk again.'
];

// The gamemode is a number up to 1.21, a name in the world state from 26.1 on.
const GAMEMODES = { survival: 0, creative: 1, adventure: 2, spectator: 3 };

// The world the bot is in, from a login or respawn packet. Modern versions put it
// in the world state; older ones carry the name beside it.
const ELSEWHERE = /minecraft:(the_end|the_nether)$/;
const DEFAULT_WORLD = { x: 0, y: 100, z: 0 };

function dimensionOf(packet) {
    if (!packet) return null;
    const state = packet.worldState && typeof packet.worldState === 'object'
        ? packet.worldState
        : packet;
    const named = state.name ?? state.dimensionName ?? state.dimension;
    if (typeof named !== 'string' || !named) return null;
    return named.includes(':') ? named : `minecraft:${named}`;
}

// The gamemode a login or game-state packet carries, as the number the rest of
// the bot compares against, or null when the packet says nothing about it.
function gamemodeOf(packet) {
    if (!packet) return null;
    const named = packet.worldState?.gamemode
        ?? packet.worldState?.gameMode
        ?? packet.gameMode
        ?? packet.gamemode;
    if (typeof named === 'string') {
        const mode = GAMEMODES[named.toLowerCase()];
        return Number.isFinite(mode) ? mode : null;
    }
    const mode = Number(named);
    return Number.isFinite(mode) ? mode : null;
}

class SelfCare {
    constructor({ bot, config = {}, logger }) {
        this.bot = bot;
        this.config = config;
        this.log = logger;

        this.enabled = config.enabled !== false;
        this.creative = config.creative !== false;
        this.commandSpy = config.commandSpy !== false;
        this.vanish = config.vanish !== false;
        this.unmute = config.unmute !== false;

        this.opLevel = 0;
        this.gamemode = null;
        this.muted = false;
        this.spyOn = false;
        this.vanished = false;
        this.ready = false;
        // Where the bot is and where it last stood in the overworld: a teleport
        // into the end leaves it with no way back on its own.
        this.dimension = null;
        this.lastOverworld = null;
        this.rescueTries = 0;
        this.recoverWorld = config.recoverWorld !== false;

        this.opRequested = false;
        this.creativeRequested = false;
        this.spyRequested = false;
        this.vanishRequested = false;
        this.unmuteRequested = false;
        // Last time creative was asked for while the gamemode was unknown.
        this.lastCreativeAt = 0;

        this.timer = null;
        this.timers = new Set();

        this.onReady = this.onReady.bind(this);
        this.onDisconnect = this.onDisconnect.bind(this);
        this.onMessage = this.onMessage.bind(this);

        bot.on('ready', this.onReady);
        bot.on('disconnect', this.onDisconnect);
        bot.on('chat', this.onMessage);

        this.timer = setInterval(() => this.tick(), TICK_MS);
        this.timer.unref?.();
    }

    // setTimeout that cannot outlive destroy(), so a reconnect storm does not
    // build up a pile of pending retries.
    later(fn, ms) {
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (this.ready) fn();
        }, ms);
        timer.unref?.();
        this.timers.add(timer);
        return timer;
    }

    get name() {
        return this.bot.server?.username || null;
    }

    get uuid() {
        return this.bot.client?.uuid || null;
    }

    // Commands go through a core block when it is ready (no chat line), and fall
    // back to a normal slash command before that.
    run(command) {
        const text = String(command ?? '').replace(/^\//, '').trim();
        if (!text) return false;

        if (this.bot.core?.ready) {
            const cell = this.bot.core.run(text);
            if (cell) return true;
        }

        // Selfcare is allowed to use chat when the core cannot take it.
        return typeof this.bot.sendChat === 'function' ? this.bot.sendChat(`/${text}`) : false;
    }

    // Plain chat command (never routed through core). Used for urgent selfcare
    // recovery (re-op, re-creative) so it still works even if core routing is bad.
    runChat(command) {
        const text = String(command ?? '').replace(/^\//, '').trim();
        if (!text) return false;
        return typeof this.bot.sendChat === 'function' ? this.bot.sendChat(`/${text}`) : false;
    }

    // Command spy and vanish need the core: a chat line would make the bot
    // visible, which is the opposite of what vanish is for.
    runWithCore(command, attempts = 10) {
        const text = String(command ?? '').replace(/^\//, '').trim();
        if (!text) return Promise.resolve(false);

        return new Promise(resolve => {
            let left = attempts;
            const attempt = () => {
                if (!this.ready) return resolve(false);
                if (left <= 0) return resolve(false);
                left -= 1;

                if (this.bot.core?.ready) {
                    const cell = this.bot.core.run(text);
                    if (cell) return resolve(true);
                }

                setTimeout(attempt, 500).unref?.();
            };
            attempt();
        });
    }

    // --- op and gamemode ----------------------------------------------------

    onEntityStatus(packet) {
        if (!packet || typeof packet.entityStatus !== 'number') return;
        const status = Number(packet.entityStatus);
        if (status < 24 || status > 28) return;

        const myId = this.bot.client?.entityId;
        if (myId != null && Number(packet.entityId) !== Number(myId)) return;

        const level = status - 24;
        if (level === 0) {
            this.opLevel = 0;
            // Deopped: recover immediately via chat with no delay.
            this.opRequested = false;
            this.askOp({ immediate: true });
            return;
        }

        this.opLevel = level;
        this.opRequested = false;
        if (this.ready && this.gamemode !== null && this.gamemode !== 1) {
            this.ensureCreative({ immediate: true });
        }
    }

    askOp({ immediate = false } = {}) {
        if (!this.ready || this.opLevel !== 0 || !this.creative) return;
        if (!immediate && this.opRequested) return;

        this.opRequested = true;
        this.log.info('no op: asking for it');
        this.runChat('op @s[type=player]');

        if (immediate) {
            // Allow an immediate re-fire if deopped again; keep a short guard
            // against tight duplicate sends from the same state.
            this.later(() => { this.opRequested = false; }, 100);
            return;
        }

        this.later(() => {
            this.opRequested = false;
            if (this.ready && this.opLevel === 0) {
                this.later(() => {
                    if (this.ready && this.opLevel === 0 && !this.opRequested) this.askOp();
                }, OP_RETRY_MS);
            }
        }, RETRY_MS);
    }

    ensureCreative({ immediate = false } = {}) {
        if (!this.ready || !this.creative) return;
        if (this.gamemode === 1) {
            this.creativeRequested = false;
            return;
        }
        if (!immediate && this.creativeRequested) return;

        if (this.opLevel === 0) {
            if (!this.opRequested) this.askOp({ immediate });
            return;
        }

        // A server that never names the gamemode cannot be read back, so a bot
        // left in survival looked after itself not at all. Creative is asked for
        // anyway - through the core when it is up, so nothing shows in chat - and
        // only every so often: with no answer to read, a request per tick would
        // be spam.
        const unknown = this.gamemode === null;
        if (unknown && !immediate
            && Date.now() - (this.lastCreativeAt || 0) < UNKNOWN_GAMEMODE_RETRY_MS) {
            return;
        }

        this.lastCreativeAt = Date.now();
        this.creativeRequested = true;
        if (unknown) this.run('gamemode creative');
        else this.runChat('gamemode creative');

        if (immediate) {
            this.later(() => { this.creativeRequested = false; }, 100);
            return;
        }

        this.later(() => {
            this.creativeRequested = false;
            if (this.ready && this.gamemode !== 1) this.ensureCreative();
        }, RETRY_MS);
    }

    // --- spy, vanish, mute --------------------------------------------------

    enableSpy() {
        if (!this.ready || !this.commandSpy || this.spyOn || this.spyRequested) return;
        const uuid = this.uuid;
        if (!uuid) return;

        this.spyRequested = true;
        this.runWithCore(`c ${uuid} on`).then(ok => {
            this.spyRequested = false;
            if (!ok && this.ready && !this.spyOn) this.later(() => this.enableSpy(), RETRY_MS);
        });
    }

    ensureVanish() {
        if (!this.ready || !this.vanish || this.vanished || this.vanishRequested) return;
        const name = this.name;
        if (!name) return;

        this.vanishRequested = true;
        this.runWithCore(`vanish ${name} enable`).then(ok => {
            this.vanishRequested = false;
            if (!ok && this.ready && !this.vanished) this.later(() => this.ensureVanish(), RETRY_MS);
        });
    }

    unmuteMe() {
        if (!this.ready || !this.unmute || !this.muted || this.unmuteRequested) return;
        const uuid = this.uuid;
        if (!uuid) return;

        this.unmuteRequested = true;
        this.runWithCore(`mute ${uuid} 0s`).then(ok => {
            this.unmuteRequested = false;
            if (ok) {
                this.muted = false;
                return;
            }
            if (this.ready && this.muted) this.later(() => this.unmuteMe(), RETRY_MS * 2);
        });
    }

    // --- lifecycle ---------------------------------------------------------

    onReady() {
        this.opLevel = 0;
        this.gamemode = null;
        this.muted = false;
        this.spyOn = false;
        this.vanished = false;
        this.opRequested = false;
        this.creativeRequested = false;
        this.spyRequested = false;
        this.vanishRequested = false;
        this.unmuteRequested = false;
        this.lastCreativeAt = 0;
        this.rescueTries = 0;
        this.ready = true;

        if (!this.enabled) return;

        setTimeout(() => {
            if (!this.ready) return;
            this.enableSpy();
            this.askOp();
            this.ensureVanish();
        }, 1500).unref?.();
    }

    onDisconnect() {
        this.ready = false;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }

    // The login packet is the first place the gamemode is known; without it the
    // bot would wait for a gamemode change that never comes. From protocol 26.1
    // (26.x servers) it is no longer a number beside the world: the player is
    // put in a world state that names the mode, `creative` rather than 1, and a
    // login packet that only looks for the old field leaves the gamemode unknown.
    onLoginPacket(packet) {
        this.noteDimension(dimensionOf(packet));
        const mode = gamemodeOf(packet);
        if (mode === null) return;
        this.gamemode = mode;
        this.creativeRequested = false;
    }

    // The position is worth keeping only while the bot is in the overworld: a
    // teleport to the end gives end coordinates, which are not where it belongs.
    notePosition(position) {
        if (!position || !Number.isFinite(position.x)) return;
        if (this.dimension && ELSEWHERE.test(this.dimension)) return;
        this.lastOverworld = { x: position.x, y: position.y, z: position.z };
    }

    // A teleport into the end (or the nether) is not a place the bot can leave on
    // its own, and its core does not exist there: it is brought back to the
    // overworld, where it last stood.
    noteDimension(name) {
        if (!name) return;
        const changed = name !== this.dimension;
        this.dimension = name;
        if (!changed) return;

        if (!ELSEWHERE.test(name)) {
            if (this.rescueTries) this.log?.info?.('back in the overworld');
            this.rescueTries = 0;
            return;
        }

        this.log?.info?.(`the bot is in ${name}; asking to be brought back to the overworld`);
        this.later(() => this.rescue(), 1500);
    }

    // `execute in the overworld` is the only way back from inside the end: a plain
    // tp would land at the same coordinates in the world the bot is already in.
    rescue() {
        if (!this.ready || !this.recoverWorld) return false;
        if (!this.dimension || !ELSEWHERE.test(this.dimension)) return false;

        const name = this.name;
        if (!name) return false;

        if (this.rescueTries >= 4) {
            this.log?.warn?.(`could not leave ${this.dimension}; the next join starts in the overworld`);
            return false;
        }

        this.rescueTries += 1;
        const at = this.lastOverworld || DEFAULT_WORLD;
        const x = Math.round(at.x);
        const y = Math.round(at.y);
        const z = Math.round(at.z);
        this.runChat(`execute in minecraft:overworld run tp ${name} ${x} ${y} ${z}`);
        this.later(() => this.rescue(), 3000);
        return true;
    }

    // The player list carries a gamemode per player, which is how newer servers
    // tell us ours when the login packet no longer does.
    noteGamemode(gamemode) {
        const mode = Number(gamemode);
        if (!Number.isFinite(mode) || mode === this.gamemode) return;
        this.gamemode = mode;
        this.creativeRequested = false;
        if (this.ready && mode !== 1) this.ensureCreative({ immediate: true });
    }

    onGameStateChange(packet) {
        if (!packet || packet.reason !== 'change_game_mode') return;
        const mode = gamemodeOf(packet);
        if (mode === null) return;
        this.gamemode = mode;
        this.creativeRequested = false;
        if (this.gamemode !== 1) this.ensureCreative({ immediate: true });
    }

    onRespawn(packet) {
        this.noteDimension(dimensionOf(packet));
        const mode = gamemodeOf(packet);
        if (mode === null) return;
        this.gamemode = mode;
        this.creativeRequested = false;
        this.vanished = false;
        this.vanishRequested = false;
        this.ensureCreative({ immediate: true });
        if (this.vanish) this.later(() => this.ensureVanish(), 1000);
    }

    onMessage({ line } = {}) {
        if (typeof line !== 'string') return;
        const text = line.replace(/\x1b\[[0-9;]*m/g, '').trim().toLowerCase();
        if (!text) return;

        if (text === 'successfully enabled commandspy') {
            this.spyOn = true;
            this.spyRequested = false;
            return;
        }
        if (text === 'successfully disabled commandspy') {
            this.spyOn = false;
            this.spyRequested = false;
            this.later(() => this.enableSpy(), 100);
            return;
        }

        if (UNMUTED_LINES.includes(text)) {
            this.muted = false;
            this.unmuteRequested = false;
            return;
        }
        if (MUTED_LINES.includes(text) || text.includes('you have been muted for') ||
            text.includes('your voice has been silenced for')) {
            this.muted = true;
            this.unmuteRequested = false;
            this.mutedAt = Date.now();
            this.unmuteMe();
            return;
        }

        const name = (this.name || '').toLowerCase();
        if (!name) return;
        if (text.includes(`vanish for ${name}: enabled`)) {
            this.vanished = true;
            this.vanishRequested = false;
            return;
        }
        if (text.includes(`vanish for ${name}: disabled`)) {
            this.vanished = false;
            this.vanishRequested = false;
            this.later(() => this.ensureVanish(), 100);
        }
    }

    tick() {
        if (!this.ready || !this.enabled) return;
        // Op is what makes creative and the core possible at all, and it is the
        // one thing that must not wait for a gamemode the server may never send.
        if (this.opLevel === 0 && !this.opRequested) this.askOp();
        this.ensureCreative();
        if (!this.spyOn && !this.spyRequested) this.enableSpy();
        if (!this.vanished && !this.vanishRequested) this.ensureVanish();
        if (this.muted && !this.unmuteRequested) this.unmuteMe();
    }

    status() {
        return {
            op: this.opLevel,
            creative: this.gamemode === 1,
            commandSpy: this.spyOn,
            vanished: this.vanished,
            muted: this.muted
        };
    }

    destroy() {
        this.ready = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.bot.removeListener('ready', this.onReady);
        this.bot.removeListener('disconnect', this.onDisconnect);
        this.bot.removeListener('chat', this.onMessage);
    }
}

module.exports = { SelfCare };
