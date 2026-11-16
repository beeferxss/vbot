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

// Flattens a Minecraft chat component into plain text.
function flatten(component) {
    component = unwrapNbt(decode(component));
    if (component === null || component === undefined) return '';
    if (typeof component === 'string') return component;
    if (typeof component === 'number' || typeof component === 'boolean') return String(component);
    if (Array.isArray(component)) return component.map(flatten).join('');
    if (typeof component !== 'object') return '';

    let out = '';

    if (typeof component.text === 'string') {
        out += interpolate(component.text, component.with);
    } else if (typeof component.translate === 'string') {
        out += interpolate(component.translate, component.with);
    } else if (typeof component.keybind === 'string') {
        out += component.keybind;
    } else if (typeof component.selector === 'string') {
        out += component.selector;
    }

    if (Array.isArray(component.with) && typeof component.text !== 'string') {
        out += component.with.map(flatten).join('');
    }
    if (component.extra) out += flatten(component.extra);

    return out;
}

function interpolate(template, args) {
    if (!Array.isArray(args) || !args.length) return template;
    let index = 0;
    return String(template).replace(/%[sd]/g, match => {
        const value = args[index++];
        const text = flatten(value);
        return match === '%d' ? text : text;
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

function pushAnsi(text, code, out) {
    const value = String(text ?? '').replace(/\u00a7./g, '').replace(/\x1b\[[0-9;]*m/g, '');
    if (!value) return;
    out.push([value, code]);
}

function collectAnsi(component, inherited, out) {
    component = unwrapNbt(decode(component));
    if (component === null || component === undefined) return;

    if (Array.isArray(component)) {
        for (const child of component) collectAnsi(child, inherited, out);
        return;
    }

    if (typeof component !== 'object') {
        pushAnsi(flatten(component), inherited, out);
        return;
    }

    const own = ansiCode(component.color) ?? inherited;

    if (Array.isArray(component.extra) && component.extra.length) {
        const base = { ...component };
        delete base.extra;
        pushAnsi(flatten(base), own, out);
        for (const child of component.extra) collectAnsi(child, own, out);
        return;
    }

    pushAnsi(flatten(component), own, out);
}

// Renders a chat component as a single ANSI-styled line.
function toAnsi(component) {
    const parts = [];
    collectAnsi(component, null, parts);
    if (!parts.length) return '';

    const styled = parts.some(([, code]) => code);
    return parts.map(([text, code]) => (code ? `\x1b[${code}m${text}` : text)).join('') + (styled ? '\x1b[0m' : '');
}

module.exports = { flatten, nearestAnsi, stripColors, toAnsi, unwrapNbt };
