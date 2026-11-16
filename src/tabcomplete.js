'use strict';

// Server-side tab completion, as a promise:
//
//   const matches = await bot.tabComplete('/gamemode c');
//
// The request and the reply are both the `tab_complete` packet; the reply
// carries the transaction id, so parallel calls cannot cross answers.
const TIMEOUT_MS = 4000;
let nextTransactionId = 0;

function attachTabComplete(bot) {
    if (typeof bot.tabComplete === 'function') return;

    bot.tabComplete = text => new Promise(resolve => {
        const client = bot.client;
        if (!client || typeof client.write !== 'function') {
            resolve([]);
            return;
        }

        const transactionId = (nextTransactionId += 1) & 0x7fffffff;
        let finished = false;

        const finish = names => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            client.removeListener('tab_complete', onResponse);
            resolve(names);
        };

        const onResponse = packet => {
            if (packet?.transactionId !== undefined && packet.transactionId !== transactionId) return;
            const matches = Array.isArray(packet?.matches) ? packet.matches : [];
            finish(matches
                .map(match => (typeof match === 'string' ? match : match?.match ?? match?.text ?? ''))
                .filter(Boolean));
        };

        const timer = setTimeout(() => finish([]), TIMEOUT_MS);
        timer.unref?.();

        client.on('tab_complete', onResponse);
        try {
            client.write('tab_complete', { transactionId, text: String(text ?? '') });
        } catch {
            finish([]);
        }
    });
}

module.exports = { attachTabComplete };
