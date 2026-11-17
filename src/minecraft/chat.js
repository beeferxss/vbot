'use strict';

const { flatten, stripColors, toAnsi } = require('./text');
const { normalizeUuid } = require('./uuid');

const mcData = require('minecraft-data');

// Translate components carry a key such as "advMode.setCommand.success"; the
// matching en_us table ships with minecraft-data, so it is resolved locally for
// whichever version this bot is running.
const languageCache = new Map();

function languageFor(version) {
    if (!version) return null;

    const key = String(version);
    if (languageCache.has(key)) return languageCache.get(key);

    let language = null;
    try {
        language = mcData(key)?.language || null;
    } catch {
        language = null;
    }

    languageCache.set(key, language);
    return language;
}

// Packet field names differ across protocol versions, so probe the known ones.
function chatTextFromPacket(packet, lang = null) {
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
        const text = flatten(candidate, lang);
        if (text) return text;
    }
    return '';
}

// A player_chat packet also carries the decorated display name (rank prefix,
// colours). Only the message component may be used for the body, or the rank
// prefix would be printed instead of what the player actually said.
function messageAnsi(packet, message, lang) {
    const styled = toAnsi(packet.unsignedChatContent ?? packet.body?.content ?? null, lang);
    if (styled && stripColors(styled).trim() === message) return styled;
    return message;
}

// Colours live in the component, and the plain line has already thrown them
// away, so the same candidates are rendered again with their ANSI styling.
function ansiFromPacket(packet, lang = null) {
    if (!packet || typeof packet === 'string') return '';

    const candidates = [
        packet.unsignedChatContent,
        packet.message,
        packet.content,
        packet.signedChat,
        packet.formattedMessage,
        packet.body?.content
    ];

    for (const candidate of candidates) {
        if (!candidate) continue;
        const ansi = toAnsi(candidate, lang);
        if (ansi) return ansi;
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
function chatEventFromPacket(event, packet, lang = null) {
    if (!packet) return null;

    if (event === 'player_chat') {
        const username = senderName(packet.networkName ?? packet.senderName);
        const message = typeof packet.plainMessage === 'string' && packet.plainMessage
            ? packet.plainMessage
            : stripColors(flatten(packet.unsignedChatContent, lang)).trim();
        if (!message) return null;

        const bodyAnsi = messageAnsi(packet, message, lang);
        return {
            line: username ? `<${username}> ${message}` : message,
            ansi: username ? `\x1b[96m<${username}>\x1b[0m ${bodyAnsi}` : bodyAnsi,
            message,
            username,
            uuid: normalizeUuid(packet.senderUuid ?? packet.sender),
            verified: true
        };
    }

    const text = stripColors(chatTextFromPacket(packet, lang)).trim();
    if (!text) return null;
    return { line: text, ansi: ansiFromPacket(packet, lang) || text, message: text, username: '', uuid: null, verified: false };
}

module.exports = { chatTextFromPacket, chatEventFromPacket, languageFor, parseChatLine, senderName };
