'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LEVEL, levelName, parseLevel } = require('../permissions');
const tellraw = require('../minecraft/tellraw');

class CommandRegistry {
    constructor({ dir, config, permissions, store, logger, tokens = null }) {
        this.dir = dir;
        this.config = config;
        this.permissions = permissions;
        this.store = store;
        this.logger = logger;
        this.tokens = tokens;
        this.commands = new Map();
        this.aliases = new Map();
    }

    loadAll() {
        const files = fs.readdirSync(this.dir).filter(file => file.endsWith('.js') && file !== 'index.js');
        for (const file of files) this.load(path.join(this.dir, file));
        this.logger.info(`loaded ${this.commands.size} command(s): ${[...this.commands.keys()].sort().join(', ')}`);
        return this;
    }

    load(fullPath) {
        const name = path.basename(fullPath, '.js');
        let command;
        try {
            delete require.cache[require.resolve(fullPath)];
            command = require(fullPath);
        } catch (error) {
            this.logger.error(`failed to load command ${name}: ${error.message}`);
            return;
        }

        if (!command || typeof command.execute !== 'function' || !command.name) {
            this.logger.error(`invalid command module ${name}: needs name and execute()`);
            return;
        }

        const level = parseLevel(command.level ?? 'public');
        if (level === null) {
            this.logger.error(`invalid level "${command.level}" in command ${name}`);
            return;
        }

        const entry = {
            name: String(command.name).toLowerCase(),
            aliases: (command.aliases || []).map(alias => String(alias).toLowerCase()),
            description: command.description || '',
            usage: command.usage || '',
            level,
            execute: command.execute
        };

        this.commands.set(entry.name, entry);
        for (const alias of entry.aliases) this.aliases.set(alias, entry.name);
    }

    find(label) {
        const key = String(label || '').toLowerCase();
        const name = this.aliases.get(key) ?? key;
        return this.commands.get(name) || null;
    }

    // Longest configured prefix wins, so "v:" beats ":"
    matchPrefix(message) {
        const prefixes = this.config.bot.prefixes || [];
        let found = null;
        for (const prefix of prefixes) {
            if (message.toLowerCase().startsWith(prefix.toLowerCase())) {
                if (!found || prefix.length > found.length) found = prefix;
            }
        }
        return found;
    }

    async dispatch({ bot, parsed, verified = true }) {
        const prefix = this.matchPrefix(parsed.message);
        if (!prefix) return false;

        const body = parsed.message.slice(prefix.length).trim();
        if (!body) return false;

        const [label, ...argv] = body.split(/\s+/);
        const command = this.find(label);
        const reply = text => this.reply(bot, parsed.username, text, command?.name || label);

        if (!command) {
            reply(`Unknown command "${label}". Try ${prefix}help`);
            return true;
        }

        // A name is only worth as much as the packet that carried it. System
        // chat can be printed by anyone ( /sudo, a plugin, a rank prefix ), so a
        // stored rank only counts for signed player chat - unless the server
        // never signs anything, which free-op and offline-mode servers do not.
        // "auto" trusts unsigned text until the first signed packet proves the
        // server is able to sign; on servers without signing that never happens
        // and ranks keep working.
        const trustSetting = this.config.chat?.trustUnsigned ?? 'auto';
        const trustUnsigned = trustSetting === 'auto'
            ? !bot.signedChatSeen
            : trustSetting === true;
        const trustedName = verified || trustUnsigned;

        let level = this.permissions.levelFor({
            name: trustedName ? parsed.username : null,
            uuid: parsed.uuid
        });

        let args = argv;

        // Privileged commands need a token derived from a secret key: it is the
        // one thing a spoofer cannot produce, and it expires within seconds.
        if (command.level > level) {
            const granted = this.tokens ? this.tokens.verify(args[0]) : null;
            if (granted === null) {
                reply(`${command.name} needs a ${levelName(command.level)} token: ${prefix}${command.name} <token> ...`);
                return true;
            }
            if (granted < command.level) {
                reply(`That token is ${levelName(granted)}; ${command.name} needs ${levelName(command.level)}.`);
                return true;
            }
            args = args.slice(1);
            level = granted;
        }

        const ctx = {
            bot,
            client: bot.client,
            config: this.config,
            store: this.store,
            permissions: this.permissions,
            tokens: this.tokens,
            logger: bot.log,
            username: parsed.username,
            uuid: parsed.uuid ?? (typeof bot.uuidFor === 'function' ? bot.uuidFor(parsed.username) : null),
            verified,
            trustedName,
            level,
            levelName: levelName(level),
            args,
            argString: args.join(' '),
            prefix,
            reply,
            // A button that runs `action(clicker)` when clicked, even though the
            // bot prefix is not a server command. Null when no tokens exist.
            clickToken: (source, action) => (bot.clickTokens ? bot.clickTokens.register(source, action) : null),
            replyPrivate: text => reply(`/msg ${parsed.username} ${text}`),
            // Commands are run through the core command blocks when it is up,
            // so they do not appear as bot chat. Chat is the bootstrap path.
            run: commandText => this.runCommand(bot, commandText)
        };

        try {
            await command.execute(ctx);
        } catch (error) {
            this.logger.error(`command ${command.name} failed: ${error.stack || error.message}`);
            reply(`Command failed: ${error.message}`);
        }
        return true;
    }

    // Replies are sent as tellraw so they are private and do not depend on chat
    // formatting. A server that will not run commands for the bot (it is not
    // opped) can be switched to "chat" with bot.reply. Text may be a plain
    // string or a tellraw component (an object or an array of parts), which is
    // how commands add colour and click events.
    reply(bot, username, text, source = 'reply') {
        const mode = this.config.bot?.reply || 'tellraw';
        let component = toComponent(text);

        // Every suggestion becomes a working button, the way the reference does
        // it: clicking runs the command as the player, through a click token.
        if (bot.clickTokens?.transform) component = bot.clickTokens.transform(component, source);

        if (mode === 'tellraw' && username) {
            const version = bot?.client?.version || this.config.minecraft?.version || null;
            return bot.chat(tellraw.command(username, component, version));
        }
        // Chat has no formatting, so flatten the component to its text.
        return bot.chat(plainText(component));
    }

    // Runs a server command. Bot.chat decides whether it goes through a core
    // command block or out as chat.
    runCommand(bot, commandText) {
        const text = String(commandText ?? '').trim().replace(/^\//, '');
        if (!text) return false;
        return bot.chat(`/${text}`);
    }

    // Commands a rank may run.
    listFor(level) {
        return this.listAll().filter(command => command.level <= level);
    }

    // Every loaded command, for a help listing that does not hide anything.
    listAll() {
        return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
}

function toComponent(text) {
    if (typeof text === 'string') {
        // "&a" colour codes become real components; plain text stays plain.
        return tellraw.colorize(text) || { text };
    }
    if (text === null || text === undefined) return { text: '' };
    return text;
}

function plainText(component) {
    if (typeof component === 'string') return component;
    if (Array.isArray(component)) return component.map(plainText).join('');
    if (!component || typeof component !== 'object') return '';
    const own = typeof component.text === 'string' ? component.text : '';
    return own + plainText(component.extra || []);
}

module.exports = { CommandRegistry, LEVEL };
