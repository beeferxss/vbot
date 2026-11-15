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

// Flattens a Minecraft chat component into plain text.
function flatten(component) {
    component = decode(component);
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

module.exports = { flatten, stripColors };
