'use strict';

// Discord bridge: everything that happens in game can be posted into a Discord
// channel through a webhook. A webhook is just a URL, so this needs no library,
// no gateway connection and no bot token - the bot only ever writes.
//
// Messages are queued and spaced out, because Discord rate limits a webhook to
// roughly one message per second per channel; anything that piles up is dropped
// rather than posted late.

const MAX_CONTENT = 1900;
const DEFAULT_GAP_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_QUEUE = 25;

const WEBHOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;

function isWebhookUrl(value) {
    return WEBHOOK_URL.test(String(value || '').trim());
}

// The bot's own plumbing arrives in chat too: the selector scan, the fill
// confirmations for every core refill, and command spy echoes of our own
// tellraw/fill. None of that belongs in a Discord channel.
function shouldRelay(line) {
    const text = String(line || '').trim();
    if (!text) return false;
    if (text.includes('[PLAYER_LIST]')) return false;
    if (/^commands\.[\w.]+\.(success|failed)/.test(text)) return false;
    if (/issued server command: \/(?:tellraw|fill|setblock|data|execute) /.test(text)) return false;
    return true;
}

// "<Steve> hi" becomes "**Steve**: hi", so Discord shows who said it.
function formatChat(line) {
    const text = String(line || '').trim();
    const match = /^<([A-Za-z0-9_]{1,16})>\s*(.*)$/.exec(text);
    if (!match) return text;
    return `**${match[1]}**: ${match[2]}`;
}

function splitContent(content, limit = MAX_CONTENT) {
    const text = String(content ?? '');
    if (text.length <= limit) return [text];

    const chunks = [];
    let rest = text;
    while (rest.length > limit) {
        const window = rest.slice(0, limit);
        const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
        const at = cut > limit * 0.5 ? cut : limit;
        chunks.push(rest.slice(0, at));
        rest = rest.slice(at).replace(/^\s+/, '');
    }
    if (rest) chunks.push(rest);
    return chunks;
}

class DiscordBridge {
    constructor({
        url,
        username = 'vbot',
        avatarUrl = null,
        logger = null,
        fetchImpl = globalThis.fetch,
        gapMs = DEFAULT_GAP_MS,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxQueue = DEFAULT_MAX_QUEUE
    } = {}) {
        this.url = String(url || '').trim();
        this.username = String(username || 'vbot');
        this.avatarUrl = avatarUrl || null;
        this.log = logger;
        this.fetch = fetchImpl;
        this.gapMs = Math.max(0, Number(gapMs) || 0);
        this.timeoutMs = Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
        this.maxQueue = Math.max(1, Number(maxQueue) || DEFAULT_MAX_QUEUE);

        this.queue = [];
        this.timer = null;
        this.nextAt = 0;
        this.sent = 0;
        this.failed = 0;
        this.dropped = 0;
        this.lastError = null;
        // A URL that is not a webhook (or no URL at all) means the bridge sits
        // there doing nothing instead of throwing on every line of chat.
        this.enabled = isWebhookUrl(this.url) && typeof this.fetch === 'function';
        if (this.url && !this.enabled) {
            this.log?.warn(`discord: "${this.url}" is not a webhook URL, so chat is not relayed`);
        }
    }

    status() {
        return {
            enabled: this.enabled,
            queued: this.queue.length,
            sent: this.sent,
            failed: this.failed,
            dropped: this.dropped,
            lastError: this.lastError
        };
    }

    // Chat is formatted for Discord; anything else is an event and goes as-is.
    chat(line) {
        if (!shouldRelay(line)) return Promise.resolve(false);
        return this.send(formatChat(line));
    }

    event(text) {
        return this.send(String(text || ''));
    }

    send(content) {
        if (!this.enabled) return Promise.resolve(false);

        return new Promise(resolve => {
            for (const chunk of splitContent(content)) {
                if (this.queue.length >= this.maxQueue) {
                    const dropped = this.queue.shift();
                    this.dropped += 1;
                    dropped?.resolve(false);
                }
                this.queue.push({ content: chunk, resolve });
            }
            this.tick();
        });
    }

    tick() {
        if (!this.enabled || this.timer || !this.queue.length) return;
        const wait = Math.max(0, this.nextAt - Date.now());
        // Not unref'd: somebody is waiting on the send, and an unref'd timer can
        // let the process exit with the message still queued.
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, wait);
    }

    async flush() {
        const item = this.queue.shift();
        if (!item) return;

        const body = {
            content: item.content,
            username: this.username,
            // Never ping a role or everyone from game chat.
            allowed_mentions: { parse: [] }
        };
        if (this.avatarUrl) body.avatar_url = this.avatarUrl;

        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timeout = controller
            ? setTimeout(() => controller.abort(), this.timeoutMs).unref?.()
            : null;

        try {
            const response = await this.fetch(this.url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller?.signal
            });
            if (response && response.ok === false) {
                this.failed += 1;
                this.lastError = `http ${response.status ?? 'error'}`;
                this.log?.warn(`discord: message rejected (${this.lastError})`);
                item.resolve(false);
            } else {
                this.sent += 1;
                item.resolve(true);
            }
        } catch (error) {
            this.failed += 1;
            this.lastError = error.name === 'AbortError' ? 'timeout' : error.message;
            this.log?.warn(`discord: could not post (${this.lastError})`);
            item.resolve(false);
        } finally {
            if (timeout) clearTimeout(timeout);
        }

        this.nextAt = Date.now() + this.gapMs;
        this.tick();
    }

    destroy() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        for (const item of this.queue.splice(0)) item.resolve(false);
    }
}

module.exports = {
    DiscordBridge,
    isWebhookUrl,
    shouldRelay,
    formatChat,
    splitContent,
    MAX_CONTENT
};
