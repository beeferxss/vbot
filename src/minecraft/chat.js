'use strict';

const { flatten, stripColors } = require('./text');

// Packet field names differ across protocol versions, so probe the known ones.
function chatTextFromPacket(packet) {
    if (!packet) return '';
    if (typeof packet === 'string') return packet;

    const candidates = [
        packet.message,
        packet.signedChat,
        packet.unsignedChat,
        packet.content,
        packet.formattedMessage,
        packet.body?.content
    ];

    for (const candidate of candidates) {
        const text = flatten(candidate);
        if (text) return text;
    }
    return '';
}

const PATTERNS = [
    /^<([A-Za-z0-9_.*-]{1,32})>\s?(.*)$/,
    /^(?:\[[^\]]{1,32}\]\s*)*([A-Za-z0-9_.*-]{1,32})\s*[:»›>]\s+(.*)$/,
    /^(?:\[[^\]]{1,32}\]\s*)*([A-Za-z0-9_.*-]{1,32})\s*[,]\s+(.*)$/
];

// Returns { username, message } for player chat, or null for server output.
function parseChatLine(line) {
    const clean = stripColors(line).replace(/\s+$/, '');
    if (!clean) return null;

    for (const pattern of PATTERNS) {
        const match = clean.match(pattern);
        if (!match) continue;
        const message = match[2].trim();
        if (!message) continue;
        return { username: match[1], message };
    }
    return null;
}

module.exports = { chatTextFromPacket, parseChatLine };
