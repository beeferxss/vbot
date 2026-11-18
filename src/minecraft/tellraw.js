'use strict';

// Tellraw components.
//
// Java 1.21.5 renamed the interactive fields and switched command arguments to
// SNBT: clickEvent/value became click_event/command, hoverEvent/contents became
// hover_event/value. The old shape still renders, but its clicks do nothing, so
// the shape has to follow the server version.
//
// Components here are plain objects with neutral fields:
//   { text, color, bold, italic, underlined,
//     click: { action, value },
//     hover: { text },
//     extra: [ ...components ] }

const MODERN_MAJOR = 1;
const MODERN_MINOR = 21;
const MODERN_PATCH = 5;

// Only the actions the bot uses; each has its own payload field in 1.21.5+.
const CLICK_FIELD = {
    open_url: 'url',
    run_command: 'command',
    suggest_command: 'command',
    copy_to_clipboard: 'value',
    change_page: 'page'
};

function isModern(version) {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? ''));
    if (!match) return true; // unknown: assume a current server

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3] || 0);

    if (major !== MODERN_MAJOR) return major > MODERN_MAJOR;
    if (minor !== MODERN_MINOR) return minor > MODERN_MINOR;
    return patch >= MODERN_PATCH;
}

function quote(value) {
    return `'${String(value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')}'`;
}

function snbt(component) {
    if (Array.isArray(component)) return `[${component.map(snbt).join(',')}]`;

    const c = component || {};
    const parts = [];
    if (c.text !== undefined) parts.push(`text:${quote(c.text)}`);
    if (c.color) parts.push(`color:${quote(c.color)}`);
    if (c.bold) parts.push('bold:1b');
    if (c.italic) parts.push('italic:1b');
    if (c.underlined) parts.push('underlined:1b');

    if (c.insertion) parts.push(`insertion:${quote(c.insertion)}`);

    if (c.click) {
        const field = CLICK_FIELD[c.click.action] || 'value';
        const payload = field === 'page' ? Number(c.click.value) : quote(c.click.value);
        parts.push(`click_event:{action:${quote(c.click.action)},${field}:${payload}}`);
    }

    if (c.hover) {
        parts.push(`hover_event:{action:'show_text',value:{text:${quote(c.hover.text)}}}`);
    }

    if (c.extra) parts.push(`extra:[${c.extra.map(snbt).join(',')}]`);

    return `{${parts.join(',')}}`;
}

function json(component) {
    if (Array.isArray(component)) return component.map(json);

    const c = component || {};
    const out = {};
    if (c.text !== undefined) out.text = String(c.text);
    if (c.color) out.color = c.color;
    if (c.bold) out.bold = true;
    if (c.italic) out.italic = true;
    if (c.underlined) out.underlined = true;

    // Shift-clicking a chat line inserts this into the chat box.
    if (c.insertion) out.insertion = String(c.insertion);

    if (c.click) {
        // The pre-1.21.5 JSON shape always used "value".
        out.clickEvent = { action: c.click.action, value: String(c.click.value) };
    }

    if (c.hover) {
        out.hoverEvent = { action: 'show_text', contents: { text: c.hover.text } };
    }

    if (c.extra) out.extra = c.extra.map(json);

    return out;
}

// The component as it goes into the tellraw command.
function payload(component, version) {
    return isModern(version) ? snbt(component) : JSON.stringify(json(component));
}

function command(target, component, version) {
    return `/tellraw ${target} ${payload(component, version)}`;
}

function text(value, style = {}) {
    return { text: String(value), ...style };
}

const COLOR_CODES = {
    0: 'black', 1: 'dark_blue', 2: 'dark_green', 3: 'dark_aqua',
    4: 'dark_red', 5: 'dark_purple', 6: 'gold', 7: 'gray',
    8: 'dark_gray', 9: 'blue', a: 'green', b: 'aqua', c: 'red',
    d: 'light_purple', e: 'yellow', f: 'white'
};

const FORMAT_CODES = { l: 'bold', o: 'italic', n: 'underlined', m: 'strikethrough', k: 'obfuscated' };

// Turns "&aReady &7- 12ms" (or the section-sign form) into coloured parts, so
// ordinary text replies can carry colour without building components by hand.
// Returns null when there is nothing to convert.
function colorize(value) {
    const source = String(value ?? '');
    if (!/[&\u00a7][0-9a-fk-or]/i.test(source)) return null;

    const parts = [];
    let style = {};
    let buffer = '';

    const flush = () => {
        if (!buffer) return;
        parts.push({ text: buffer, ...style });
        buffer = '';
    };

    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        const code = char === '&' || char === '\u00a7' ? source[index + 1]?.toLowerCase() : null;

        if (code && (code === 'r' || COLOR_CODES[code] || FORMAT_CODES[code])) {
            flush();
            if (code === 'r') style = {};
            else if (COLOR_CODES[code]) style = { color: COLOR_CODES[code] };
            else style = { ...style, [FORMAT_CODES[code]]: true };
            index++;
            continue;
        }

        buffer += char;
    }

    flush();
    return parts.length ? parts : null;
}

module.exports = { colorize, command, isModern, json, payload, snbt, text };
