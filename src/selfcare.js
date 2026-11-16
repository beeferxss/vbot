'use strict';

// Keeps the bot in a usable state on free-op servers: it asks for op when it has
// none, stays in creative, keeps command spy and vanish on, and undoes a mute.
// Ported from the reference bot's selfcare plugin, told apart by what it can
// actually observe here: packets arrive through the Bot, and commands go through
// the core when it is up.

const RETRY_MS = 700;
const TICK_MS = 1500;
const OP_RETRY_MS = 5000;

// Both the vanilla wording and the plugin wordings the reference listens for.
const MUTED_LINES = [
    'you have been muted!',
    'your voice has been silenced!'
];
const UNMUTED_LINES = [
    'you have been muted for now.',
    'you can now talk again.'
];

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
        this.nick = config.nick !== false;
        this.username = config.username !== false;

        this.opLevel = 0;
        this.gamemode = null;
        this.muted = false;
        this.spyOn = false;
        this.vanished = false;
        this.ready = false;

        this.opRequested = false;
        this.creativeRequested = false;
        this.spyRequested = false;
        this.vanishRequested = false;
        this.unmuteRequested = false;
        this.nickSent = false;
        this.usernameSent = false;

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

        return this.bot.chat(`/${text}`);
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
            if (this.opRequested) return;
            this.askOp();
            return;
        }

        this.opLevel = level;
        this.opRequested = false;
        if (this.ready && this.gamemode !== null && this.gamemode !== 1) {
            this.later(() => this.ensureCreative(), 300);
        }
    }

    askOp() {
        if (!this.ready || this.opLevel !== 0 || this.opRequested || !this.creative) return;

        this.opRequested = true;
        this.log.info('no op: asking for it');
        this.run('/op @s[type=player]');

        this.later(() => {
            this.opRequested = false;
            if (this.ready && this.opLevel === 0) {
                this.later(() => {
                    if (this.ready && this.opLevel === 0 && !this.opRequested) this.askOp();
                }, OP_RETRY_MS);
            }
        }, RETRY_MS);
    }

    ensureCreative() {
        if (!this.ready || !this.creative || this.gamemode === null) return;
        if (this.gamemode === 1) {
            this.creativeRequested = false;
            return;
        }
        if (this.creativeRequested) return;

        if (this.opLevel === 0) {
            if (!this.opRequested) this.askOp();
            return;
        }

        this.creativeRequested = true;
        this.run('/gamemode creative');
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

    // Nick and username are one-shot per session: the server keeps them, and
    // repeating them every tick would just spam.
    applyNick() {
        const nick = (this.config.nickName ?? this.config.nick ?? '').trim?.() ?? '';
        if (!this.ready || !this.nick || !nick || this.nickSent) return;

        this.nickSent = true;
        this.log.info(`setting nickname to ${nick}`);
        this.bot.chat(`/nick ${nick}`);
    }

    applyUsername() {
        const name = (this.config.usernameName ?? '').trim?.() ?? '';
        if (!this.ready || !this.username || !name || this.usernameSent) return;

        this.usernameSent = true;
        this.log.info(`setting username to ${name}`);
        this.bot.chat(`/username ${name}`);
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
        this.nickSent = false;
        this.usernameSent = false;
        this.ready = true;

        if (!this.enabled) return;

        setTimeout(() => {
            if (!this.ready) return;
            this.enableSpy();
            this.askOp();
            this.ensureVanish();
            this.applyNick();
            this.applyUsername();
        }, 1500).unref?.();
    }

    onDisconnect() {
        this.ready = false;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }

    // The login packet is the first place the gamemode is known; without it the
    // bot would wait for a gamemode change that never comes.
    onLoginPacket(packet) {
        if (!packet || packet.gameMode === undefined) return;
        this.gamemode = Number(packet.gameMode);
        this.creativeRequested = false;
    }

    onGameStateChange(packet) {
        if (!packet || packet.reason !== 'change_game_mode') return;
        this.gamemode = Number(packet.gameMode);
        this.creativeRequested = false;
        if (this.gamemode !== 1) this.ensureCreative();
    }

    onRespawn(packet) {
        if (!packet || packet.gamemode === undefined) return;
        this.gamemode = Number(packet.gamemode);
        this.creativeRequested = false;
        this.vanished = false;
        this.vanishRequested = false;
        this.nickSent = false;
        this.usernameSent = false;
        this.ensureCreative();
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
