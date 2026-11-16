'use strict';

// A local terminal for the running bots. Only starts when stdin is a real TTY,
// so it never interferes with CI or with `node src/index.js > log`.
//
//   /<command>        send a server command to the selected bots
//   <text>            say it in chat
//   .server <id|all>  choose the target
//   .status           state and core readiness of every bot
//   .help             this list
//   exit              close the console (the bots keep running)

const readline = require('node:readline');

function attachConsole({ manager, logger, config }) {
    if (!manager) return null;
    if (config?.console?.enabled === false) return null;
    if (!process.stdin.isTTY) return null;

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'vbot> '
    });

    let target = 'all';
    const write = text => process.stdout.write(`${text}\n`);
    const all = () => (typeof manager.list === 'function' ? manager.list() : []);

    const selected = () => {
        const bots = all();
        if (target === 'all') return bots;
        const one = bots.find(bot => bot.id.toLowerCase() === target);
        return one ? [one] : [];
    };

    const status = bot => {
        const core = bot.core;
        const coreText = !core
            ? 'no core'
            : `core ${core.ready ? 'ready' : 'not ready'}`;
        return `${bot.id.padEnd(12)} ${String(bot.state).padEnd(11)} ${coreText}`;
    };

    write('vbot console: /<command> runs a server command, .server <id|all>, .status, .help, exit');
    rl.prompt();

    rl.on('line', line => {
        const text = String(line || '').trim();
        if (!text) return rl.prompt();

        if (text === 'exit' || text === 'quit' || text === '.exit' || text === '.quit') {
            rl.close();
            return;
        }

        if (text === '.help') {
            write('/<command>        send a server command to the selected bots');
            write('<text>            say it in chat');
            write('.server <id|all>  choose the target (current: ' + target + ')');
            write('.status           state and core readiness of every bot');
            write('exit              close the console');
            return rl.prompt();
        }

        if (text === '.status' || text === '.servers' || text === '.list') {
            const bots = all();
            if (!bots.length) write('no bots');
            for (const bot of bots) write(status(bot));
            return rl.prompt();
        }

        if (text.startsWith('.server')) {
            const wanted = text.split(/\s+/)[1]?.toLowerCase();
            if (!wanted) {
                write(`usage: .server <id|all> (available: ${all().map(bot => bot.id).join(', ')})`);
                return rl.prompt();
            }
            if (wanted !== 'all' && !all().some(bot => bot.id.toLowerCase() === wanted)) {
                write(`unknown server "${wanted}"; available: ${all().map(bot => bot.id).join(', ')}, all`);
                return rl.prompt();
            }
            target = wanted;
            write(`target: ${target}`);
            return rl.prompt();
        }

        if (text.startsWith('.')) {
            write(`unknown console command "${text.split(/\s+/)[0]}"; try .help`);
            return rl.prompt();
        }

        const bots = selected().filter(bot => bot.state === 'ready');
        if (!bots.length) {
            write(`no connected bot selected (${target})`);
            return rl.prompt();
        }

        const message = text.replace(/^say\s+/i, '');
        for (const bot of bots) {
            try {
                bot.chat(message);
                write(`[${bot.id}] ${message.startsWith('/') ? message : `say: ${message}`}`);
            } catch (error) {
                logger?.error?.(`console ${bot.id}: ${error.message}`);
                write(`[${bot.id}] failed: ${error.message}`);
            }
        }
        return rl.prompt();
    });

    rl.on('SIGINT', () => rl.close());

    return {
        close() {
            try { rl.close(); } catch { /* already closed */ }
        }
    };
}

module.exports = { attachConsole };
