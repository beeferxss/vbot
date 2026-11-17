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

// Colours are rendered as truecolor ANSI, the way a client does, and only
// reduced to the sixteen terminal colours on the way into Discord.
function ansiRgb(color) {
    if (!color || typeof color !== 'string') return null;
    const key = color.toLowerCase();
    const hex = NAMED_COLORS[key] || (/^#[0-9a-f]{6}$/.test(key) ? key : null);
    if (!hex) return null;

    return [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16)
    ];
}

function ansiTruecolor([red, green, blue]) {
    return `\x1b[38;2;${red};${green};${blue}m`;
}

// Legacy servers put colours in the text as §-codes; they are turned into the
// same ANSI the relay already understands instead of being stripped.
const LEGACY_COLORS = {
    '0': '#000000', '1': '#0000aa', '2': '#00aa00', '3': '#00aaaa', '4': '#aa0000', '5': '#aa00aa',
    '6': '#ffaa00', '7': '#aaaaaa', '8': '#555555', '9': '#5555ff', a: '#55ff55', b: '#55ffff',
    c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff'
};

// Bold, italic, underline, blink (how a terminal can fake obfuscated) and
// strikethrough, plus the reset.
const LEGACY_STYLES = { k: 5, l: 1, m: 9, n: 4, o: 3, r: 0 };

function legacyAnsi(text) {
    return String(text ?? '').replace(/\u00a7([0-9a-fk-or])/gi, (_, code) => {
        const key = code.toLowerCase();
        if (key in LEGACY_STYLES) return `\x1b[${LEGACY_STYLES[key]}m`;
        const rgb = ansiRgb(LEGACY_COLORS[key]);
        return rgb ? ansiTruecolor(rgb) : '';
    });
}

const PLAIN_STYLE = {
    color: null,
    bold: false,
    italic: false,
    underlined: false,
    strikethrough: false,
    obfuscated: false
};

// A component only overrides what it sets; everything else comes from its
// parent, which is how the client draws a line.
function styleOf(component, inherited) {
    const style = { ...inherited };
    const color = component.color;

    if (typeof color === 'string') {
        if (color.toLowerCase() === 'reset') {
            Object.assign(style, PLAIN_STYLE);
        } else {
            const rgb = ansiRgb(color);
            if (rgb) style.color = rgb;
        }
    }

    for (const flag of ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated']) {
        if (typeof component[flag] === 'boolean') style[flag] = component[flag];
    }

    return style;
}

function styleAnsi(style) {
    const flags = [];
    if (style.bold) flags.push(1);
    if (style.italic) flags.push(3);
    if (style.underlined) flags.push(4);
    if (style.obfuscated) flags.push(5);
    if (style.strikethrough) flags.push(9);

    if (!style.color && !flags.length) return '';

    // Styling without a colour has to clear whatever colour came before it.
    let out = style.color ? ansiTruecolor(style.color) : '\x1b[39m';
    for (const flag of flags) out += `\x1b[${flag}m`;
    return out;
}

function pushAnsi(text, prefix, out) {
    const value = legacyAnsi(text).replace(/\u00a7./g, '');
    if (!value) return;
    out.push([value, prefix]);
}

function collectAnsi(component, inherited, out, lang = null) {
    component = unwrapNbt(decode(component));
    if (component === null || component === undefined) return;

    if (Array.isArray(component)) {
        for (const child of component) collectAnsi(child, inherited, out, lang);
        return;
    }

    if (typeof component !== 'object') {
        pushAnsi(flatten(component, lang), styleAnsi(inherited), out);
        return;
    }

    const style = styleOf(component, inherited);

    if (Array.isArray(component.extra) && component.extra.length) {
        const base = { ...component };
        delete base.extra;
        pushAnsi(flatten(base, lang), styleAnsi(style), out);
        for (const child of component.extra) collectAnsi(child, style, out, lang);
        return;
    }

    pushAnsi(flatten(component, lang), styleAnsi(style), out);
}

// Renders a chat component as a single ANSI-styled line: the colours and styles
// the server sent, as 24-bit escapes, which both terminals and Discord read.
function toAnsi(component, lang = null) {
    const parts = [];
    collectAnsi(component, PLAIN_STYLE, parts, lang);
    if (!parts.length) return '';

    const styled = parts.some(([text, prefix]) => prefix || text.includes('\x1b['));
    return parts.map(([text, prefix]) => `${prefix}${text}`).join('') + (styled ? '\x1b[0m' : '');
}

module.exports = { flatten, stripColors, toAnsi, unwrapNbt };
