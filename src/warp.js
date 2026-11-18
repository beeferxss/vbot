'use strict';

// Cloudflare WARP through warproxy: an npm dependency that runs a SOCKS5 proxy on
// localhost and sends everything pointed at it through a userspace WireGuard
// tunnel. No root, no daemon, no install step - and the bot's own traffic goes
// through it, so every connection leaves from the WARP address.
//
// A filtered bot needs a different address: registering a new free WARP account
// and restarting the proxy is exactly that. Nothing here assumes warproxy is
// present; without it every call fails softly and the bot connects directly.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { socksConnect } = require('./socks');

const DEFAULT_PORT = 25344;
// The first start downloads the engine and registers an account; later ones are
// quick. The bot waits for the tunnel instead of connecting around it.
const DEFAULT_TIMEOUT_MS = 180000;
const READY_TRIES = 120;
const READY_DELAY_MS = 500;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// minecraft-protocol starts a new client with ended = true and only clears it in
// setSocket, so a client that is still waiting for its connection looks ended.
// It is gone when it has been destroyed, when the socket it was given has ended,
// or, before any socket, when client.end() ended its packet stream while the
// tunnel was still being opened.
function clientGone(client) {
    if (client.destroyed) return true;
    if (client.socket) return Boolean(client.ended || client.socket.destroyed);
    return client.serializer?.writableEnded === true;
}

// Runs the client and always resolves, so a missing binary, a hanging proxy or a
// non-zero exit is a result rather than an exception.
function runCommand(binary, args, timeoutMs) {
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
    constructor({ config = {}, logger, run = null, connect = socksConnect }) {
        this.config = config || {};
        this.enabled = this.config.enabled === true;
        this.binary = this.config.binary ? String(this.config.binary) : null;
        this.host = String(this.config.host || '127.0.0.1');
        this.port = Number(this.config.port) > 0 ? Math.floor(Number(this.config.port)) : DEFAULT_PORT;
        this.timeoutMs = Number(this.config.timeoutMs) > 0
            ? Number(this.config.timeoutMs)
            : DEFAULT_TIMEOUT_MS;
        this.log = logger;
        this.run = typeof run === 'function' ? run : runCommand;
        this.openSocketOver = typeof connect === 'function' ? connect : socksConnect;
        // What the last status said, and the last thing that went wrong.
        this.lastStatus = null;
        this.lastError = null;
        // After a start that did not come up, the next attempts do not wait again:
        // they connect directly until this has passed.
        this.blockedUntil = 0;
        // What the run has already said about the proxy, so the line is printed
        // when it changes rather than per connection.
        this.reported = null;
    }

    // Where the bot points to reach the tunnel.
    get proxyUrl() {
        return `socks5h://${this.host}:${this.port}`;
    }

    // The dependency's own binary, or one the config names.
    binaryPath() {
        if (this.binary) return this.binary;
        const local = path.join(__dirname, '..', 'node_modules', '.bin', 'warproxy');
        return fs.existsSync(local) ? local : 'warproxy';
    }

    async call(...args) {
        try {
            return await this.run(this.binaryPath(), args, this.timeoutMs);
        } catch (error) {
            return { ok: false, stdout: '', stderr: error.message };
        }
    }

    // Any answer from the client means it is there; the text says whether the
    // proxy is up.
    async status() {
        const result = await this.call('status');
        this.lastStatus = (result.ok ? result.stdout : result.stderr) || null;
        return this.lastStatus;
    }

    async available() {
        return Boolean(await this.status());
    }

    // Brings the proxy up if it is not: start is detached, so it returns before
    // the tunnel is ready and the status is what says the tunnel is ready.
    async ensure() {
        if (!this.enabled) return false;
        if (Date.now() < this.blockedUntil) return false;
        if (await this.available()) return true;

        const started = await this.call('start', '--detach', '--no-update-check', '--port', String(this.port));
        if (!started.ok) {
            this.lastError = started.stderr || 'start failed';
            this.log?.warn?.(`warproxy did not start: ${this.lastError}`);
        }

        for (let attempt = 0; attempt < READY_TRIES; attempt += 1) {
            if (await this.available()) {
                this.lastError = null;
                return true;
            }
            await sleep(READY_DELAY_MS);
        }

        this.lastError = this.lastStatus || 'the proxy never came up';
        this.blockedUntil = Date.now() + 60000;
        this.log?.warn?.(`warproxy is not up: ${this.lastError}`);
        return false;
    }

    // A new address: a new WARP account, then the proxy again on it.
    async rotate() {
        if (!this.enabled) return false;

        await this.call('stop');

        const registered = await this.call('register', '--force');
        if (!registered.ok && !/already|exists/i.test(registered.stderr)) {
            this.lastError = registered.stderr || 'registration failed';
            this.log?.warn?.(`warp registration failed: ${this.lastError}`);
            return false;
        }

        const restarted = await this.call('restart', '--detach', '--no-update-check', '--port', String(this.port));
        if (!restarted.ok) {
            this.lastError = restarted.stderr || 'restart failed';
            this.log?.warn?.(`warproxy did not restart: ${this.lastError}`);
            return false;
        }

        const up = await this.ensure();
        if (up) this.log?.info?.('warp address changed');
        return up;
    }

    // The socket the client should use: through the tunnel when the proxy is up.
    async openSocket({ host, port }) {
        await this.ensure();
        return this.openSocketOver({
            proxyHost: this.host,
            proxyPort: this.port,
            host,
            port,
            timeoutMs: this.timeoutMs
        });
    }

    // One line in the run: whether the connection went through the tunnel. It
    // carries nothing about the address itself.
    report(used) {
        if (this.reported === used) return;
        this.reported = used;
        console.log(used ? 'proxy: on (connected through WARP)' : 'proxy: off (connected directly)');
    }

    // Gives the client a socket to the server, through the tunnel, and falls back
    // to a direct connection when the proxy cannot carry it: being online without
    // WARP beats a reconnect loop that never gets in.
    async attach(client, { host, port }) {
        try {
            const socket = await this.openSocket({ host, port });
            if (clientGone(client)) {
                socket.destroy();
                return false;
            }
            client.setSocket(socket);
            // The socket is already connected, so the event the client waits for
            // has come and gone.
            client.emit('connect');
            socket.resume?.();
            this.report(true);
            return true;
        } catch (error) {
            this.lastError = error.message;
            this.log?.warn?.(`the WARP proxy could not carry it (${error.message}); connecting directly`);
            this.report(false);
            if (clientGone(client)) return false;
            client.setSocket(net.connect({ host, port }));
            return false;
        }
    }
}

module.exports = { Warp, runCommand, DEFAULT_PORT };
