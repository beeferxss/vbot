'use strict';

const tellraw = require('./minecraft/tellraw');

// One message style for cross-server chat, shared by `netmsg` and `serverchat`.
function routeComponent({ from, fromAddress, toAddress = null, message }) {
    const route = toAddress ? `${fromAddress} -> ${toAddress}` : fromAddress;
    const limit = 256;
    const body = String(message ?? '').slice(0, limit);

    return [
        {
            text: `[${route}] `,
            color: 'aqua',
            click: { action: 'copy_to_clipboard', value: route },
            hover: { text: 'click to copy the route' }
        },
        {
            text: String(from || '?'),
            color: 'green',
            click: { action: 'copy_to_clipboard', value: String(from || '?') },
            hover: { text: `sent from ${fromAddress}` }
        },
        { text: ': ', color: 'gray' },
        { text: body, color: 'white' }
    ];
}

// Sends a tellraw to @a on that bot, through its core when the core is up.
function send(bot, component) {
    if (!bot || bot.state !== 'ready') return false;
    const version = bot.client?.version || null;
    return bot.chat(`/tellraw @a ${tellraw.payload(component, version)}`) !== false;
}

module.exports = { routeComponent, send };
