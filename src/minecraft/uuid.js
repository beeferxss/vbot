'use strict';

const crypto = require('node:crypto');

const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BARE = /^[0-9a-f]{32}$/;

function fromBuffer(buffer) {
    const hex = buffer.toString('hex');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32)
    ].join('-');
}

// Accepts the shapes a uuid can reach us in: dashed string, bare hex string,
// a 16-byte Buffer from the wire, or an array of four 32-bit ints.
function normalizeUuid(value) {
    if (value === null || value === undefined) return null;

    if (Buffer.isBuffer(value)) {
        return value.length === 16 ? fromBuffer(value) : null;
    }

    if (Array.isArray(value)) {
        if (value.length !== 4) return null;
        const buffer = Buffer.alloc(16);
        value.forEach((part, index) => buffer.writeInt32BE(Number(part) | 0, index * 4));
        return fromBuffer(buffer);
    }

    const text = String(value).trim().toLowerCase();
    if (DASHED.test(text)) return text;
    if (BARE.test(text)) {
        return [
            text.slice(0, 8),
            text.slice(8, 12),
            text.slice(12, 16),
            text.slice(16, 20),
            text.slice(20, 32)
        ].join('-');
    }
    return null;
}

// Offline-mode UUIDs are version-3 (MD5) name-based UUIDs over
// "OfflinePlayer:<name>", exactly like java.util.UUID.nameUUIDFromBytes.
// They are only valid on servers running with online-mode=false.
function offlineUuid(name) {
    if (!name) return null;
    const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
    hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
    hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
    return fromBuffer(hash);
}

function shortUuid(uuid) {
    const normalized = normalizeUuid(uuid);
    return normalized ? normalized.replace(/-/g, '').slice(0, 8) : null;
}

module.exports = { normalizeUuid, offlineUuid, shortUuid };
