'use strict';

// Clickable buttons that actually run something.
//
// A tellraw component can only run a command the clicking player is allowed to
// run, and vbot's prefix is not a command at all, so a button cannot run
// "v\core refill" directly. Instead the click runs a harmless vanilla command
// with a random number in it - /random value N..N+1 - and the server prints
// "<player> issued server command: /random value N..N+1" to chat. That line
// carries the clicker's name and the number identifies the action, so the bot
// can run the real action as the player who clicked.
//
// Tokens are not single-use: a button stays clickable until its TTL runs out,
// because a chat button can be clicked more than once.

const { stripColors } = require('./minecraft/text');

const TOKEN_TTL_MS = 3 * 60 * 1000;
const RANGE_MAX = 2_000_000_000;
const CLEANUP_MS = 60 * 1000;

// Servers word this line differently; the number is what must match.
const PATTERNS = [
    /([A-Za-z0-9_.-]{1,32})\s+issued server command:\s*\/random\s+value\s+(\d+)\.\.(\d+)/i,
    /([A-Za-z0-9_.-]{1,32})\s+executed command:\s*\/random\s+value\s+(\d+)\.\.(\d+)/i,
    /([A-Za-z0-9_.-]{1,32})\s+(?:ran|used) command:?\s*\/random\s+value\s+(\d+)\.\.(\d+)/i,
    /^\s*(?:\[[^\]]{0,32}\]\s*)*([A-Za-z0-9_.-]{1,32})\s*[:>]\s*\/random\s+value\s+(\d+)\.\.(\d+)/i,
    // Last resort: the name is whatever comes before the command.
    /([A-Za-z0-9_.-]{2,32})[^\n]{0,40}\/random\s+value\s+(\d+)\.\.(\d+)/i
];

class ClickTokens {
    constructor({ logger, uuidFor = null, onCommand = null }) {
        this.log = logger;
        this.uuidFor = uuidFor;
        // Called as onCommand(suggestion, clicker) for a transformed button.
        this.onCommand = onCommand;
        this.tokens = new Map();
        this.timer = setInterval(() => this.prune(), CLEANUP_MS);
        this.timer.unref?.();
    }

    makeToken() {
        let start;
        let command;
        do {
            start = Math.floor(Math.random() * RANGE_MAX);
            command = `/random value ${start}..${start + 1}`;
        } while (this.tokens.has(command));
        return command;
    }

    // Returns the command to put in a run_command click event. When the button
    // was sent to one player, "player" pins it to them: the echo line names the
    // clicker, and a token only works for the player it was issued to. That is
    // what makes the clicker's identity good enough to trust their rank.
    register(source, action, { player = null } = {}) {
        this.prune();
        const command = this.makeToken();
        this.tokens.set(command, {
            source: String(source || 'unknown').toLowerCase(),
            player: player ? String(player).toLowerCase() : null,
            action,
            createdAt: Date.now()
        });
        return command;
    }

    resolve(command) {
        const key = String(command || '').trim();
        const entry = this.tokens.get(key);
        if (!entry) return null;
        if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
            this.tokens.delete(key);
            return null;
        }
        return entry;
    }

    // Turns every suggest_command into a real button automatically, so nothing
    // has to be wired up per command: clicking runs the command as the clicker.
    transform(component, source = 'reply', { player = null } = {}) {
        if (Array.isArray(component)) {
            return component.map(part => this.transform(part, source, { player }));
        }
        if (!component || typeof component !== 'object') return component;

        const out = { ...component };
        if (out.click?.action === 'suggest_command' && typeof out.click.value === 'string') {
            const suggestion = out.click.value.trim();
            if (suggestion && this.onCommand) {
                const token = this.register(source, clicker => this.onCommand(suggestion, clicker), { player });
                out.click = { action: 'run_command', value: token };
            }
        }
        if (Array.isArray(out.extra)) {
            out.extra = out.extra.map(part => this.transform(part, source, { player }));
        }
        return out;
    }

    // Drops every token for a button source, so a stale button stops working.
    invalidate(source) {
        const key = String(source || '').toLowerCase();
        let dropped = 0;
        for (const [command, entry] of this.tokens) {
            if (entry.source !== key) continue;
            this.tokens.delete(command);
            dropped++;
        }
        return dropped;
    }

    prune() {
        const now = Date.now();
        for (const [command, entry] of this.tokens) {
            if (now - entry.createdAt > TOKEN_TTL_MS) this.tokens.delete(command);
        }
    }

    // "<player> issued server command: /random value 1..2" -> run the action.
    handle(line) {
        const text = stripColors(String(line || '')).trim();
        if (!text || !text.toLowerCase().includes('/random value')) return false;

        for (const pattern of PATTERNS) {
            const match = pattern.exec(text);
            if (!match) continue;

            const clicker = match[1];
            const command = `/random value ${match[2]}..${match[3]}`;
            const entry = this.resolve(command);
            if (!entry) {
                this.log.debug(`no click token for ${command}`);
                return false;
            }

            // A button sent to one player only answers for that player, so the
            // name on the echo line cannot be borrowed from someone else.
            if (entry.player && entry.player !== String(clicker).toLowerCase()) {
                this.log.warn(`click token for ${entry.player} used by ${clicker}; ignored`);
                return false;
            }

            const player = { name: clicker, uuid: this.uuidFor ? this.uuidFor(clicker) : null };
            Promise.resolve()
                .then(() => entry.action(player))
                .catch(error => this.log.error(`click action ${entry.source} failed: ${error.message}`));
            return true;
        }

        return false;
    }

    clear() {
        this.tokens.clear();
    }

    destroy() {
        clearInterval(this.timer);
        this.timer = null;
        this.tokens.clear();
    }
}

module.exports = { ClickTokens, TOKEN_TTL_MS };
