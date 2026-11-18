'use strict';

// Enough of SOCKS5 to carry a Minecraft client: no authentication, one CONNECT,
// TCP only. The host goes to the proxy as a name (the socks5h behaviour), so the
// lookup happens at the far end of the tunnel and nothing here leaks a local one.

const net = require('node:net');

const VERSION = 0x05;

const REPLIES = {
    0x01: 'general failure',
    0x02: 'connection not allowed',
    0x03: 'network unreachable',
    0x04: 'host unreachable',
    0x05: 'connection refused',
    0x06: 'TTL expired',
    0x07: 'command not supported',
    0x08: 'address type not supported'
};

function addressField(host) {
    const name = String(host || '');
    if (net.isIP(name) === 4) {
        return Buffer.from([0x01, ...name.split('.').map(part => Number(part) & 0xff)]);
    }
    const bytes = Buffer.from(name, 'utf8');
    if (!bytes.length || bytes.length > 255) throw new Error(`host is not usable for SOCKS5: ${name}`);
    return Buffer.concat([Buffer.from([0x03, bytes.length]), bytes]);
}

function connectRequest(host, port) {
    const number = Math.max(1, Math.min(65535, Math.floor(Number(port) || 0)));
    return Buffer.concat([
        Buffer.from([VERSION, 0x01, 0x00]),
        addressField(host),
        Buffer.from([(number >> 8) & 0xff, number & 0xff])
    ]);
}

// Opens a socket to `host:port` through the SOCKS5 proxy, resolving with the
// socket once the proxy says the tunnel is up, and rejecting on anything else.
function socksConnect({ proxyHost = '127.0.0.1', proxyPort = 25344, host, port, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        let request;
        try {
            request = connectRequest(host, port);
        } catch (error) {
            reject(error);
            return;
        }

        const socket = net.connect({ host: proxyHost, port: Number(proxyPort) });
        let buffer = Buffer.alloc(0);
        let stage = 'greeting';
        let settled = false;

        const clear = () => {
            clearTimeout(timer);
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.removeListener('close', onClose);
        };

        const fail = error => {
            if (settled) return;
            settled = true;
            clear();
            socket.destroy();
            reject(error);
        };

        const timer = setTimeout(
            () => fail(new Error(`the proxy did not answer in ${timeoutMs}ms`)),
            Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000
        );
        timer.unref?.();

        const onError = error => fail(error);
        const onClose = () => fail(new Error('the proxy closed the connection'));

        const onData = chunk => {
            buffer = Buffer.concat([buffer, chunk]);

            if (stage === 'greeting') {
                if (buffer.length < 2) return;
                if (buffer[0] !== VERSION) return fail(new Error('that is not a SOCKS5 proxy'));
                if (buffer[1] !== 0x00) return fail(new Error('the proxy wants a username and password'));
                buffer = buffer.subarray(2);
                stage = 'reply';
                socket.write(request);
                return;
            }

            // version, reply, reserved, address type, address, port
            if (buffer.length < 4) return;
            if (buffer[0] !== VERSION) return fail(new Error('that is not a SOCKS5 reply'));
            if (buffer[1] !== 0x00) {
                return fail(new Error(`the proxy refused it: ${REPLIES[buffer[1]] || `reply ${buffer[1]}`}`));
            }

            const type = buffer[3];
            let addressBytes;
            if (type === 0x01) addressBytes = 4;
            else if (type === 0x04) addressBytes = 16;
            else if (type === 0x03) {
                if (buffer.length < 5) return;
                addressBytes = 1 + buffer[4];
            } else {
                return fail(new Error(`the proxy answered with address type ${type}`));
            }

            const total = 4 + addressBytes + 2;
            if (buffer.length < total) return;

            const rest = buffer.subarray(total);
            settled = true;
            clear();
            // The client attaches its own reader; anything the tunnel already
            // delivered belongs to it, so the socket is left paused with those
            // bytes put back until it does.
            socket.pause();
            if (rest.length) socket.unshift(rest);
            resolve(socket);
        };

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
        // The greeting is queued even before the socket is up.
        socket.write(Buffer.from([VERSION, 0x01, 0x00]));
    });
}

module.exports = { socksConnect, connectRequest, REPLIES };
