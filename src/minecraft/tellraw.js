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

module.exports = { command, isModern, json, payload, snbt, text };
