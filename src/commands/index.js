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
        // Wired after construction by index.js; commands like `servers` and
        // `netmsg` need every bot, not just the one they were typed on.
        this.manager = null;
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
            execute: command.execute,
            // Optional extra hover detail `help` prints under the entry: a
            // command with variants (servercrash's methods) names them itself.
            hover: command.hover ?? null
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
        // In-game commands can be turned off entirely: no chat line then starts
        // one, and only a raw dispatch (Discord's /sudo, the console) gets in.
        if (this.config.bot?.inGamePrefixes === false) return null;

        const prefixes = this.config.bot.prefixes || [];
        let found = null;
        for (const prefix of prefixes) {
            if (message.toLowerCase().startsWith(prefix.toLowerCase())) {
                if (!found || prefix.length > found.length) found = prefix;
            }
        }
        return found;
    }

    // `raw` takes the message as the command already, with no bot prefix to
    // strip (Discord's /sudo). `sink` sees every reply as it goes out, so a
    // caller outside the game can keep the output; the player is still answered.
    async dispatch({ bot, parsed, verified = true, real = true, trustedClicker = false, raw = false, sink = null }) {
        const prefix = raw ? '' : this.matchPrefix(parsed.message);
        if (prefix === null) return false;

        const text = String(parsed.message ?? '');
        const body = (raw ? text : text.slice(prefix.length)).trim();
        if (!body) return false;

        const [label, ...argv] = body.split(/\s+/);
        const command = this.find(label);
        const reply = text => {
            if (typeof sink === 'function') {
                try { sink(text); } catch { /* a bad sink is not the command's problem */ }
            }
            return this.reply(bot, parsed.username, text, command?.name || label);
        };

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
        // A click token was handed to one player and only answers for them, so
        // the name on its echo line is as good as signed chat: the player keeps
        // their own rank and cannot borrow anyone else's.
        const trustedName = verified || trustUnsigned || trustedClicker;

        // A rank is only used for a real chat packet: player_chat, or the old
        // chat packet on servers that predate it. A custom chat plugin prints its
        // lines through tellraw, which is free-form text anyone can shape, so a
        // command that arrives that way runs as public - it still runs, it just
        // does not carry a rank it could have borrowed from someone else's name.
        // The same goes for a vanished player: they are online by selector only,
        // so nothing they send can be taken as coming from a listed account.
        const presence = bot.online?.get(String(parsed.username || '').toLowerCase());
        const vanished = presence?.vanished === true;
        const rankUsable = !vanished && (trustedClicker || (real !== false && (verified || trustUnsigned)));

        let level = rankUsable
            ? this.permissions.levelFor({ name: parsed.username, uuid: parsed.uuid })
            : LEVEL.PUBLIC;

        let args = argv;

        // Privileged commands need a token derived from a secret key: it is the
        // one thing a spoofer cannot produce, and it expires within seconds.
        if (command.level > level) {
            const granted = this.tokens ? this.tokens.verify(args[0]) : null;
            if (granted === null) {
                const why = vanished
                    ? ' (you are vanished, so your rank is not used)'
                    : real === false
                        ? ' (this is not a chat message, so your rank is not used)'
                        : '';
                reply(`${command.name} needs a ${levelName(command.level)} token: ${prefix}${command.name} <token> ...${why}`);
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
            bots: this.manager?.bots || new Map([[bot.id, bot]]),
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
            // Both are private tellraw to the player who asked.
            replyPrivate: reply,
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
    // formatting, and they go through the core like every other command. Text
    // may be a plain string or a tellraw component (an object or an array of
    // parts), which is how commands add colour and click events.
    reply(bot, username, text, source = 'reply') {
        let component = toComponent(text);

        // Every suggestion becomes a working button, the way the reference does
        // it: clicking runs the command as the player, through a click token that
        // only works for the player this reply is addressed to.
        if (bot.clickTokens?.transform) {
            component = bot.clickTokens.transform(component, source, { player: username });
        }

        const version = bot?.client?.version || this.config.minecraft?.version || null;
        return bot.chat(tellraw.command(username || '@a', component, version));
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

module.exports = { CommandRegistry, LEVEL };
