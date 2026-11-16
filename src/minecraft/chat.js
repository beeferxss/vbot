'use strict';

const { flatten, stripColors } = require('./text');
const { normalizeUuid } = require('./uuid');

// Packet field names differ across protocol versions, so probe the known ones.
function chatTextFromPacket(packet) {
    if (!packet) return '';
    if (typeof packet === 'string') return packet;

    const candidates = [
        packet.message,
        packet.plainMessage,
        packet.signedChat,
        packet.unsignedChat,
        packet.content,
        packet.unsignedChatContent,
        packet.formattedMessage,
        packet.body?.content
    ];

    for (const candidate of candidates) {
        const text = flatten(candidate);
        if (text) return text;
    }
    return '';
}

// Display names arrive decorated by rank plugins ("[ADMIN] Alex"), so reduce
// them to the account name the server actually knows.
function senderName(component) {
    const text = stripColors(flatten(component)).trim();
    if (!text) return '';
    const stripped = text.replace(/^(?:\[[^\]]{0,32}\]\s*)+/, '').trim();
    const match = stripped.match(/^[A-Za-z0-9_.*-]{1,32}/);
    return match ? match[0] : '';
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

// A message is only as trustworthy as the packet that carried it:
//
//  - player_chat is the server telling us "account X sent this", with the sender
//    uuid attached, so the name is not taken from text we could be tricked by.
//  - system_chat (and legacy chat) is free-form text. Anyone able to print a
//    line - /sudo, a plugin, a rank prefix - can make it look like player chat,
//    so it is reported as unverified and never grants a stored rank.
function chatEventFromPacket(event, packet) {
    if (!packet) return null;

    if (event === 'player_chat') {
        const username = senderName(packet.networkName ?? packet.senderName);
        const message = typeof packet.plainMessage === 'string' && packet.plainMessage
            ? packet.plainMessage
            : stripColors(flatten(packet.unsignedChatContent)).trim();
        if (!message) return null;

        return {
            line: username ? `<${username}> ${message}` : message,
            message,
            username,
            uuid: normalizeUuid(packet.senderUuid ?? packet.sender),
            verified: true
        };
    }

    const text = stripColors(chatTextFromPacket(packet)).trim();
    if (!text) return null;
    return { line: text, message: text, username: '', uuid: null, verified: false };
}

module.exports = { chatTextFromPacket, chatEventFromPacket, parseChatLine, senderName };
