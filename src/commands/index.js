'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LEVEL, levelName, parseLevel } = require('../permissions');

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
        const reply = text => bot.chat(text);

        if (!command) {
            reply(`Unknown command "${label}". Try ${prefix}help`);
            return true;
        }

        // A name is only worth as much as the packet that carried it. System
        // chat can be printed by anyone ( /sudo, a plugin, a rank prefix ), so
        // a stored rank or config list only counts for signed player chat.
        let level = this.permissions.levelFor({
            name: verified ? parsed.username : null,
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
            level,
            levelName: levelName(level),
            args,
            argString: args.join(' '),
            prefix,
            reply,
            replyPrivate: text => reply(`/msg ${parsed.username} ${text}`)
        };

        try {
            await command.execute(ctx);
        } catch (error) {
            this.logger.error(`command ${command.name} failed: ${error.stack || error.message}`);
            reply(`Command failed: ${error.message}`);
        }
        return true;
    }

    // Commands visible to a rank, for the help listing.
    listFor(level) {
        return [...this.commands.values()]
            .filter(command => command.level <= level)
            .sort((a, b) => a.name.localeCompare(b.name));
    }
}

module.exports = { CommandRegistry, LEVEL };
