'use strict';

// Cloudflare WARP, driven through its own client. A filtered bot needs a different
// address, and WARP is the one that can be turned over from inside a workflow
// runner: deleting the registration and making a new one is a new public address,
// then reconnect.
//
// Nothing here assumes warp-cli is installed. Without it every call fails softly
// and the caller logs it once and stays in the game.

const { execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 20000;

// Runs warp-cli and always resolves, so a missing binary, a hanging daemon or a
// non-zero exit is a result rather than an exception.
function runWarp(binary, args, timeoutMs) {
    return new Promise(resolve => {
        execFile(binary, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                stdout: String(stdout || '').trim(),
                stderr: String(stderr || error?.message || '').trim()
            });
        });
    });
}

class Warp {
    constructor({ config = {}, logger, run = null }) {
        this.config = config || {};
        this.enabled = this.config.enabled === true;
        this.binary = String(this.config.binary || 'warp-cli');
        this.timeoutMs = Number(this.config.timeoutMs) > 0
            ? Number(this.config.timeoutMs)
            : DEFAULT_TIMEOUT_MS;
        this.log = logger;
        this.run = typeof run === 'function' ? run : runWarp;
        // What the last status said, for the logs and for tests.
        this.lastStatus = null;
    }

    // Every call carries --accept-tos: the runner has no one to click through a
    // prompt, and the flag is ignored once the terms are already accepted.
    args(...args) {
        return ['--accept-tos', ...args];
    }

    async call(...args) {
        try {
            return await this.run(this.binary, this.args(...args), this.timeoutMs);
        } catch (error) {
            return { ok: false, stdout: '', stderr: error.message };
        }
    }

    async status() {
        const result = await this.call('status');
        this.lastStatus = result.ok ? result.stdout : null;
        return this.lastStatus;
    }

    // Whether warp-cli is there at all: a status that answers anything means the
    // daemon and the client both are.
    async available() {
        return Boolean(await this.status());
    }

    async connect() {
        const result = await this.call('connect');
        if (!result.ok) {
            this.log?.warn?.(`warp connect failed: ${result.stderr || 'unknown error'}`);
            return false;
        }
        this.log?.info?.('warp connected');
        return true;
    }

    async disconnect() {
        const result = await this.call('disconnect');
        // Already disconnected is not a failure worth reporting.
        return result.ok || /not connected|disconnected/i.test(result.stderr);
    }

    // A new address: drop the current identity, register a fresh one and connect.
    // Returns whether the bot has an address it did not have before.
    async rotate() {
        if (!this.enabled) return false;

        await this.disconnect();
        await this.call('registration', 'delete');

        const registration = await this.call('registration', 'new');
        if (!registration.ok && !/already|exists/i.test(registration.stderr)) {
            this.log?.warn?.(`warp registration failed: ${registration.stderr || 'unknown error'}`);
            return false;
        }

        const connected = await this.connect();
        if (connected) this.log?.info?.('warp address changed');
        return connected;
    }
}

module.exports = { Warp, runWarp };
