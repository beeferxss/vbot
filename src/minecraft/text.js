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

module.exports = { flatten, stripColors, unwrapNbt };
