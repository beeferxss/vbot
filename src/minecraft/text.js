'use strict';

// Components arrive as a JSON string, a component object, or an array of
// components depending on protocol version and packet, so decode first.
function decode(component) {
    if (typeof component !== 'string') return component;
    const trimmed = component.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return component;
    try {
        return JSON.parse(trimmed);
    } catch {
        return component;
    }
}

// NBT-shaped text arrives from minecraft-protocol as prismarine-nbt nodes
// ({ type: 'compound', value: { text: { type: 'string', value: 'hi' } } }),
// not as plain components, so unwrap them before flattening.
function unwrapNbt(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(unwrapNbt);

    if (typeof value.type === 'string' && 'value' in value) {
        const inner = value.value;
        if (value.type === 'compound') {
            const out = {};
            for (const [key, child] of Object.entries(inner || {})) out[key] = unwrapNbt(child);
            return out;
        }
        if (value.type === 'list') {
            const items = inner && Array.isArray(inner.value) ? inner.value : [];
            return items.map(unwrapNbt);
        }
        if (value.type === 'byte') return Boolean(inner);
        return unwrapNbt(inner);
    }

    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = unwrapNbt(child);
    return out;
}

// Flattens a Minecraft chat component into plain text. A translate component
// carries a key and arguments, not the sentence, so the version's language
// table turns "advMode.setCommand.success" into "Command set: %s". Without a
// table the key is shown, which is what the client would print for a string it
// has no translation for.
function flatten(component, lang = null) {
    component = unwrapNbt(decode(component));
    if (component === null || component === undefined) return '';
    if (typeof component === 'string') return component;
    if (typeof component === 'number' || typeof component === 'boolean') return String(component);
    if (Array.isArray(component)) return component.map(child => flatten(child, lang)).join('');
    if (typeof component !== 'object') return '';

    let out = '';
    let argsDone = false;

    if (typeof component.text === 'string') {
        out += interpolate(component.text, component.with, lang);
    } else if (typeof component.translate === 'string') {
        const args = Array.isArray(component.with) ? component.with : [];
        const template = lang ? lang[component.translate] : null;

        // Some servers and plugins send the format string as the translate key
        // ("[%s] %s › %s") instead of a real key, so a missing key is used as
        // the template rather than printed with the arguments glued after it.
        const resolved = typeof template === 'string';
        const format = resolved ? template : component.translate;
        out += interpolate(format, args, lang);
        // Without a table, a key that has placeholders is a format in its own
        // right; one that has none keeps its arguments appended so nothing is
        // silently lost.
        argsDone = resolved || /%%|%(?:\d+\$)?[sd]/.test(format);
    } else if (typeof component.keybind === 'string') {
        out += component.keybind;
    } else if (typeof component.selector === 'string') {
        out += component.selector;
    }

    const args = Array.isArray(component.with) ? component.with : [];
    if (!argsDone && args.length && typeof component.text !== 'string') {
        out += args.map(child => flatten(child, lang)).join('');
    }
    if (component.extra) out += flatten(component.extra, lang);

    return out;
}

// Minecraft has both positional (%s, %d) and indexed (%1$s) placeholders.
function interpolate(template, args, lang = null) {
    if (!Array.isArray(args) || !args.length) return template;
    let index = 0;
    return String(template).replace(/%%|%(?:(\d+)\$)?[sd]/g, (match, position) => {
        if (match === '%%') return '%';
        const at = position ? Number(position) - 1 : index++;
        return at < args.length ? flatten(args[at], lang) : '';
    });
}

function stripColors(text) {
    return String(text ?? '').replace(/\u00a7./g, '').replace(/\x1b\[[0-9;]*m/g, '');
}

// The chat feed is relayed to Discord as an ANSI code block, which only knows
// the sixteen terminal colours, so every component colour is reduced to the
// closest one of those.
const ANSI_COLORS = [
    [0x00, 0x00, 0x00, 30], [0xaa, 0x00, 0x00, 31], [0x00, 0xaa, 0x00, 32], [0xaa, 0x55, 0x00, 33],
    [0x00, 0x00, 0xaa, 34], [0xaa, 0x00, 0xaa, 35], [0x00, 0xaa, 0xaa, 36], [0xaa, 0xaa, 0xaa, 37],
    [0x55, 0x55, 0x55, 90], [0xff, 0x55, 0x55, 91], [0x55, 0xff, 0x55, 92], [0xff, 0xff, 0x55, 93],
    [0x55, 0x55, 0xff, 94], [0xff, 0x55, 0xff, 95], [0x55, 0xff, 0xff, 96], [0xff, 0xff, 0xff, 97]
];

const NAMED_COLORS = {
    black: '#000000',
    dark_blue: '#0000aa',
    dark_green: '#00aa00',
    dark_aqua: '#00aaaa',
    dark_red: '#aa0000',
    dark_purple: '#aa00aa',
    gold: '#ffaa00',
    gray: '#aaaaaa',
    dark_gray: '#555555',
    blue: '#5555ff',
    green: '#55ff55',
    aqua: '#55ffff',
    red: '#ff5555',
    light_purple: '#ff55ff',
    yellow: '#ffff55',
    white: '#ffffff'
};

function nearestAnsi(red, green, blue) {
    let best = 37;
    let bestDistance = Infinity;

    for (const [r, g, b, code] of ANSI_COLORS) {
        const distance = (red - r) ** 2 + (green - g) ** 2 + (blue - b) ** 2;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = code;
        }
    }

    return best;
}

function ansiCode(color) {
    if (!color || typeof color !== 'string') return null;
    const key = color.toLowerCase();
    const hex = NAMED_COLORS[key] || (/^#[0-9a-f]{6}$/.test(key) ? key : null);
    if (!hex) return null;

    return nearestAnsi(
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16)
    );
}

// Legacy servers put colours in the text as §-codes; they are turned into the
// same ANSI the relay already understands instead of being stripped.
const LEGACY_COLORS = {
    '0': 30, '1': 34, '2': 32, '3': 36, '4': 31, '5': 35, '6': 33, '7': 37,
    '8': 90, '9': 94, a: 92, b: 96, c: 91, d: 95, e: 93, f: 97
};

function legacyAnsi(text) {
    return String(text ?? '').replace(/\u00a7([0-9a-fk-or])/gi, (_, code) => {
        const key = code.toLowerCase();
        if (key === 'r') return '\x1b[0m';
        const ansi = LEGACY_COLORS[key];
        return ansi === undefined ? '' : `\x1b[${ansi}m`;
    });
}

function pushAnsi(text, code, out) {
    const value = legacyAnsi(text).replace(/\u00a7./g, '');
    if (!value) return;
    out.push([value, code]);
}

function collectAnsi(component, inherited, out, lang = null) {
    component = unwrapNbt(decode(component));
    if (component === null || component === undefined) return;

    if (Array.isArray(component)) {
        for (const child of component) collectAnsi(child, inherited, out, lang);
        return;
    }

    if (typeof component !== 'object') {
        pushAnsi(flatten(component, lang), inherited, out);
        return;
    }

    const own = ansiCode(component.color) ?? inherited;

    if (Array.isArray(component.extra) && component.extra.length) {
        const base = { ...component };
        delete base.extra;
        pushAnsi(flatten(base, lang), own, out);
        for (const child of component.extra) collectAnsi(child, own, out, lang);
        return;
    }

    pushAnsi(flatten(component, lang), own, out);
}

// Renders a chat component as a single ANSI-styled line.
function toAnsi(component, lang = null) {
    const parts = [];
    collectAnsi(component, null, parts, lang);
    if (!parts.length) return '';

    // A reset is needed when any part carries a colour, either from the
    // component or from §-codes already turned into ANSI.
    const styled = parts.some(([text, code]) => code || text.includes('\x1b['));
    return parts.map(([text, code]) => (code ? `\x1b[${code}m${text}` : text)).join('') + (styled ? '\x1b[0m' : '');
}

module.exports = { flatten, nearestAnsi, stripColors, toAnsi, unwrapNbt };
