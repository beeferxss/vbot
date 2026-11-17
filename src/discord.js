'use strict';

// Two-way Discord bridge.
//
//   Minecraft -> Discord: the whole chat feed - player chat, tellraw, command
//   output, joins and leaves - is posted to that server's channel as an ANSI
//   code block. Lines are batched and the same line is only posted once.
//   Tellraw and command output are part of that feed, including the tellraw the
//   bridge itself sends for a Discord message.
//
//   Discord -> Minecraft: messages in that channel are shown in game with a
//   coloured tellraw (name, reply target, click to copy), through the core when
//   it is ready and as chat when it is not.
//
//   Slash commands: /servers, /players and /mc, which runs a vbot command with
//   the member's Discord rank.
//
// discord.js is loaded lazily, so the bot runs and the selfcheck passes when
// the dependency or the token is missing.

const tellraw = require('./minecraft/tellraw');
const { LEVEL, levelName, parseLevel } = require('./permissions');
const { nearestAnsi } = require('./minecraft/text');

const RELAY = Object.freeze({
    interval: 900,
    maxBuffer: 50,
    limit: 1900,
    maxRetries: 3
});
const SEEN_TTL_MS = 3000;
const MC_LIMIT = 500;

function channelFor(config, server) {
    const channels = config?.discord?.channels || {};
    const direct = server?.channelId;
    const mapped = channels?.[server?.id] ?? channels?.[String(server?.id || '').toLowerCase()];
    const id = String(direct || mapped || '').trim();
    return id || null;
}

function oneLine(text, limit) {
    return String(text ?? '')
        .replace(/\r?\n/g, ' ')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, limit);
}

function displayName(member, user) {
    return String(member?.displayName || user?.globalName || user?.username || 'unknown')
        .replace(/§/g, '')
        .slice(0, 80);
}

function formatMentions(message) {
    let text = message.content || '';

    for (const [id, role] of message.mentions?.roles ?? []) {
        text = text.split(`<@&${id}>`).join(`@${role.name || 'role'}`);
    }

    for (const [id, channel] of message.mentions?.channels ?? []) {
        text = text.split(`<#${id}>`).join(`#${channel.name || 'channel'}`);
    }

    for (const [id, user] of message.mentions?.users ?? []) {
        const name = message.mentions.members?.get(id)?.displayName
            || user.globalName
            || user.username
            || 'user';

        text = text
            .split(`<@${id}>`).join(`@${name}`)
            .split(`<@!${id}>`).join(`@${name}`);
    }

    return text.replace(/<a?:([A-Za-z0-9_~]+):\d+>/g, ':$1:');
}

function stripMarkdown(text) {
    return String(text ?? '')
        .replace(/```([\s\S]*?)```/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/\|\|(.+?)\|\|/g, '$1')
        .replace(/^\s*>\s?/gm, '')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

const URL_PATTERN = /https?:\/\/[^\s<>()\[\]]+/g;

// Links are clickable in game, not just text. Chat has no other way to open a
// URL, and a pasted link is the most common thing a Discord message carries.
function linkParts(text, color = '#d4d4d4') {
    const parts = [];
    let last = 0;

    for (const match of String(text).matchAll(URL_PATTERN)) {
        if (match.index > last) parts.push({ text: text.slice(last, match.index), color });

        const url = match[0];
        parts.push({
            text: url,
            color: 'aqua',
            underlined: true,
            click: { action: 'open_url', value: url },
            hover: { text: `Open ${url}` }
        });

        last = match.index + url.length;
    }

    if (last < text.length) parts.push({ text: text.slice(last), color });
    return parts;
}

// Plain messages only carry text, so attachments and embeds are described
// instead of being dropped silently. Each attachment is a [attachment] button
// that opens its URL.
function describeMessage(message) {
    const parts = [];
    const text = stripMarkdown(formatMentions(message)).trim();
    if (text) parts.push(...linkParts(text));

    for (const attachment of message.attachments?.values?.() ?? []) {
        const url = String(attachment.url || '');
        const label = { text: ' [attachment]', color: 'aqua', underlined: true };

        if (url) {
            label.click = { action: 'open_url', value: url };
            label.hover = { text: `Open ${attachment.name || 'attachment'}` };
        }

        parts.push(label);
    }

    for (const sticker of message.stickers?.values?.() ?? []) {
        parts.push({ text: ` [sticker: ${sticker.name || 'sticker'}]`, color: '#d4d4d4' });
    }

    for (const embed of message.embeds ?? []) {
        const label = embed.title || embed.description || embed.url || 'embed';
        const text = ` [embed: ${stripMarkdown(label).slice(0, 200)}]`;

        if (embed.url) {
            parts.push({
                text,
                color: 'aqua',
                underlined: true,
                click: { action: 'open_url', value: String(embed.url) },
                hover: { text: `Open ${embed.url}` }
            });
        } else {
            parts.push({ text, color: '#d4d4d4' });
        }
    }

    return parts;
}

async function repliedTo(message) {
    const id = message.reference?.messageId;
    if (!id) return '';

    const channel = message.channel;
    let target = channel?.messages?.cache?.get?.(id);

    if (!target) {
        target = await channel?.messages?.fetch?.(id).catch(() => null);
    }

    if (!target || target.author?.bot) return '';
    return displayName(target.member, target.author);
}

function stripAnsiCodes(text) {
    return String(text ?? '')
        .replace(/\x1b\[[0-9;]*m/g, '')
        // Replacement characters are broken bytes from the server's own font
        // or encoding; Discord can only show them as boxes.
        .replace(/\ufffd/g, '');
}

// The same line can reach the bridge twice; normalise it to one key so it is
// only posted once.
function dedupeKey(text) {
    let key = stripAnsiCodes(text).trim();
    key = key.replace(/^(\[[^\]]+\]\s*)+/g, '');
    key = key.replace(/^<([^>]+)>\s*/, '$1: ');
    return key.replace(/\s+/g, ' ').trim();
}

// Discord's ansi code block only renders the sixteen terminal colours, so any
// truecolor the chat renderer produced is reduced to the nearest one.
function toDiscordAnsi(text) {
    return String(text ?? '')
        .replace(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g, (_, red, green, blue) =>
            `\x1b[${nearestAnsi(Number(red), Number(green), Number(blue))}m`)
        .replace(/\x1b\[48;2;[0-9;]+m/g, '')
        .replace(/\u00a7./g, '')
        .replace(/\ufffd/g, '');
}

// Keep user text from closing the surrounding Discord code block.
function protectFences(text) {
    return String(text ?? '').replace(/```/g, '`\u200b`\u200b`');
}

function ansiBlock(text) {
    return `\`\`\`ansi\n${protectFences(text)}\n\`\`\``;
}

function takeBatch(lines) {
    let content = '';
    let consumed = 0;

    for (const line of lines) {
        const next = content ? `${content}\n${line}` : line;
        if (next.length > RELAY.limit) break;
        content = next;
        consumed += 1;
    }

    return { content, consumed };
}

function onlineNames(bot) {
    const names = [];
    if (bot?.online instanceof Map) {
        for (const player of bot.online.values()) if (player?.name) names.push(player.name);
    }
    return names.sort((a, b) => a.localeCompare(b));
}

function truncateParts(parts, limit) {
    const out = [];
    let used = 0;

    for (const part of parts) {
        const text = String(part.text ?? '');
        if (!text) continue;
        if (used >= limit) break;

        if (used + text.length > limit) {
            out.push({ ...part, text: text.slice(0, limit - used) });
            break;
        }

        out.push(part);
        used += text.length;
    }

    return out;
}

// The in-game message for a Discord post: the author is clickable and hoverable
// so staff can see the tag and id without leaving the game, and the body keeps
// its links as open_url buttons.
function discordComponent({ author, message, replyTo = '', link = '', tag = '', id = '' }) {
    const name = oneLine(author, 64) || 'unknown';
    const parts = Array.isArray(message)
        ? message
        : [{ text: oneLine(message, MC_LIMIT), color: '#d4d4d4' }];
    const body = truncateParts(parts, MC_LIMIT);

    const badge = {
        text: '[Discord] ',
        color: '#55aaff'
    };

    if (link) {
        badge.click = { action: 'copy_to_clipboard', value: link };
        badge.hover = { text: `Discord\n\n${link}` };
    }

    return [
        badge,
        {
            text: name,
            color: '#62d66b',
            click: { action: 'copy_to_clipboard', value: name },
            hover: {
                text: `Discord User\n\nTag: ${tag || name}\nID: ${id || 'unknown'}` +
                    (replyTo ? `\nReplying to: ${replyTo}` : '')
            }
        },
        {
            text: replyTo ? ` (reply to @${replyTo}): ` : ': ',
            color: '#d4d4d4'
        },
        ...body
    ];
}

class DiscordBridge {
    constructor({ config, manager, logger, registry }) {
        this.root = config;
        this.config = config?.discord || {};
        this.manager = manager;
        this.registry = registry;
        this.log = logger;
        this.client = null;
        this.discord = null;
        this.started = false;
        this.commandsRegistered = false;
        this.relays = new Map();      // server id -> relay
        this.channelBots = new Map(); // channel id -> bot
        this.onMinecraftChat = (bot, event) => this.handleMinecraftChat(bot, event);
        this.onBotDisconnect = bot => {
            const relay = this.relays.get(bot.id);
            if (relay) void this.flush(relay);
        };
    }

    get enabled() {
        return this.config.enabled === true;
    }

    get ready() {
        return Boolean(this.client?.isReady?.());
    }

    start() {
        if (!this.enabled || this.started) return false;
        if (!this.config.token) {
            this.log?.warn?.('discord: enabled but discord.token is empty; bridge disabled');
            return false;
        }

        let discord;
        try {
            // eslint-disable-next-line global-require
            discord = require('discord.js');
        } catch {
            this.log?.warn?.('discord: discord.js is not installed; bridge disabled');
            return false;
        }

        this.discord = discord;
        this.started = true;
        this.buildRelays();

        const client = new discord.Client({
            intents: [
                discord.GatewayIntentBits.Guilds,
                discord.GatewayIntentBits.GuildMessages,
                // Needed for plain messages in the channel. Without it Discord
                // only delivers slash commands; the bridge still works that way.
                discord.GatewayIntentBits.MessageContent
            ],
            partials: [discord.Partials.Channel]
        });
        this.client = client;

        const onReady = () => {
            this.log?.info?.(`discord: logged in as ${client.user?.tag || client.user?.username || 'unknown'}`);
            void this.registerCommands();
        };
        client.once('ready', onReady);
        client.once('clientReady', onReady);

        client.on('messageCreate', message => {
            this.handleDiscordMessage(message).catch(error =>
                this.log?.warn?.(`discord: message relay failed: ${error.message}`));
        });
        client.on('interactionCreate', interaction => {
            this.handleInteraction(interaction).catch(error =>
                this.log?.warn?.(`discord: interaction failed: ${error.message}`));
        });
        client.on('error', error => this.log?.warn?.(`discord: client error: ${error.message}`));

        this.manager.on('chat', this.onMinecraftChat);
        this.manager.on('disconnect', this.onBotDisconnect);

        client.login(this.config.token).catch(error => {
            this.log?.warn?.(`discord: login failed: ${error.message}`);
            this.client = null;
            this.started = false;
            try { client.destroy(); } catch { /* already gone */ }
        });

        return true;
    }

    buildRelays() {
        const bots = typeof this.manager.list === 'function' ? this.manager.list() : [];
        for (const bot of bots) {
            const channelId = channelFor(this.root, bot.server);
            if (!channelId) {
                this.log?.info?.(`discord: ${bot.id} has no channelId; bridge skipped for it`);
                continue;
            }
            if (this.channelBots.has(channelId)) {
                this.log?.warn?.(`discord: channel ${channelId} is already bridged; ${bot.id} skipped`);
                continue;
            }

            this.relays.set(bot.id, {
                bot,
                channelId,
                buffer: [],
                timer: null,
                flushing: false,
                retries: 0,
                recent: new Map(),
                stopped: false
            });
            this.channelBots.set(channelId, bot);
        }
    }

    isCommand(text) {
        const prefixes = this.root?.bot?.prefixes || [];
        const value = String(text || '').toLowerCase();
        return prefixes.some(prefix => value.startsWith(String(prefix).toLowerCase()));
    }

    // The server can repeat a line (system and player packets, a reload), so the
    // same text inside a short window is only posted once.
    alreadySeen(relay, text, ttl = SEEN_TTL_MS) {
        const key = dedupeKey(text);
        if (!key) return true;

        const now = Date.now();
        const seen = relay.recent.get(key);
        if (seen && now - seen < ttl) return true;

        relay.recent.set(key, now);
        if (relay.recent.size > 100) {
            for (const [entry, at] of relay.recent) {
                if (now - at > 10000) relay.recent.delete(entry);
            }
        }

        return false;
    }

    handleMinecraftChat(bot, event) {
        if (!this.ready || this.config.relay?.chat === false) return;

        const relay = this.relays.get(bot.id);
        if (!relay) return;

        const parsed = event?.parsed;
        const ansi = String(event?.ansi || event?.line || '').replace(/\u0000/g, '').replace(/\s+$/, '');
        if (!ansi.trim()) return;

        const plain = stripAnsiCodes(ansi).trim();
        // Our own chat and command spam stay out; tellraw, command output and the
        // relay's own in-game lines are part of the feed.
        if (parsed?.username && parsed.username.toLowerCase() === String(bot.server?.username || '').toLowerCase()) return;
        if (parsed?.message && this.isCommand(parsed.message)) return;
        if (this.alreadySeen(relay, plain)) return;

        relay.buffer.push(toDiscordAnsi(ansi));
        while (relay.buffer.length > RELAY.maxBuffer) relay.buffer.shift();
        this.schedule(relay);
    }

    schedule(relay, delay = RELAY.interval) {
        if (relay.timer || relay.stopped) return;
        relay.timer = setTimeout(() => {
            relay.timer = null;
            void this.flush(relay);
        }, delay);
        relay.timer.unref?.();
    }

    async fetchChannel(channelId) {
        if (!this.ready) return null;
        try {
            const channel = this.client.channels.cache.get(String(channelId))
                || await this.client.channels.fetch(String(channelId));
            if (!channel || typeof channel.send !== 'function') return null;
            return channel;
        } catch {
            return null;
        }
    }

    async flush(relay) {
        if (relay.flushing || relay.stopped || !relay.buffer.length || !this.ready) return;

        relay.flushing = true;

        try {
            const channel = await this.fetchChannel(relay.channelId);
            if (!channel) {
                relay.retries += 1;
                if (relay.retries > RELAY.maxRetries) {
                    this.log?.warn?.(`discord: channel ${relay.channelId} is unavailable; dropping ${relay.buffer.length} line(s)`);
                    relay.buffer.length = 0;
                    relay.retries = 0;
                } else {
                    this.schedule(relay, 5000 * relay.retries);
                }
                return;
            }

            while (relay.buffer.length) {
                const { content, consumed } = takeBatch(relay.buffer);
                if (!content || !consumed) break;

                await channel.send({
                    content: ansiBlock(content),
                    allowedMentions: { parse: [] }
                });

                relay.buffer.splice(0, consumed);
            }

            relay.retries = 0;
        } catch (error) {
            relay.retries += 1;
            if (relay.retries > RELAY.maxRetries) {
                this.log?.warn?.(`discord: relay failed ${relay.retries} time(s); dropping ${relay.buffer.length} line(s): ${error.message}`);
                relay.buffer.length = 0;
                relay.retries = 0;
            } else {
                this.log?.warn?.(`discord: relay send failed (attempt ${relay.retries}), retrying: ${error.message}`);
                this.schedule(relay, 2000 * relay.retries);
            }
        } finally {
            relay.flushing = false;
            if (relay.buffer.length && !relay.timer && !relay.stopped) this.schedule(relay);
        }
    }

    flushAll() {
        for (const relay of this.relays.values()) void this.flush(relay);
    }

    async handleDiscordMessage(message) {
        if (!this.ready || this.config.relay?.discord === false) return;
        if (!message?.guild || message.author?.bot) return;

        const content = String(message.content || '').trim();
        if (content.startsWith(String(this.config.commandPrefix || '!'))) return;

        const bot = this.channelBots.get(message.channelId);
        if (!bot) return;

        const author = displayName(message.member, message.author);
        const replyTo = await repliedTo(message);
        const body = describeMessage(message);

        if (!plainText(body).trim() && !replyTo) return;

        this.sendToMinecraft(bot, discordComponent({
            author,
            message: body,
            replyTo,
            link: this.config.link || '',
            tag: message.author?.tag || message.author?.username || author,
            id: message.author?.id || ''
        }));
    }

    sendToMinecraft(bot, component) {
        if (!bot || bot.state !== 'ready') return false;

        const command = tellraw.command('@a', component, bot.client?.version || null);
        // A tellraw needs the core (or op in chat); a plain line is the last
        // resort so the message is not lost.
        const sent = bot.chat(command);
        if (sent !== false) return true;

        const text = Array.isArray(component)
            ? component.map(part => part.text || '').join('')
            : String(component?.text || '');
        return bot.sendChat(text.slice(0, 256)) !== false;
    }

    async registerCommands() {
        if (this.commandsRegistered || !this.ready) return;
        const { SlashCommandBuilder } = this.discord;

        const definitions = [
            new SlashCommandBuilder()
                .setName('servers')
                .setDescription('Every bot server with its player count'),
            new SlashCommandBuilder()
                .setName('players')
                .setDescription('Online players')
                .addStringOption(option => option
                    .setName('server')
                    .setDescription('Server id (default: the one linked to this channel)')
                    .setRequired(false)),
            new SlashCommandBuilder()
                .setName('auth')
                .setDescription('Give a player a rank in game (never above your own)')
                .addStringOption(option => option.setName('player').setDescription('Minecraft name').setRequired(true))
                .addStringOption(option => option
                    .setName('rank')
                    .setDescription('Rank to give; public removes it')
                    .setRequired(true)
                    .addChoices(
                        { name: 'trusted', value: 'trusted' },
                        { name: 'admin', value: 'admin' },
                        { name: 'owner', value: 'owner' },
                        { name: 'public (remove)', value: 'public' }
                    )),
            new SlashCommandBuilder()
                .setName('filter')
                .setDescription('Manage the player filter')
                .addStringOption(option => option
                    .setName('action')
                    .setDescription('status, list, add, remove, clear, on, off, player, uuid, ip, regex, mute, rescan')
                    .setRequired(true))
                .addStringOption(option => option.setName('value').setDescription('Name, uuid, ip, regex or on/off').setRequired(false))
                .addStringOption(option => option.setName('server').setDescription('Server id (default: this channel)').setRequired(false)),
            new SlashCommandBuilder()
                .setName('whitelist')
                .setDescription('Manage the whitelist')
                .addStringOption(option => option
                    .setName('action')
                    .setDescription('status, list, add, remove, clear, on, off, player, uuid, ip, rescan')
                    .setRequired(true))
                .addStringOption(option => option.setName('value').setDescription('Name, uuid, ip or on/off').setRequired(false))
                .addStringOption(option => option.setName('server').setDescription('Server id (default: this channel)').setRequired(false)),
            new SlashCommandBuilder()
                .setName('alts')
                .setDescription('Addresses behind a player, or accounts on an address')
                .addStringOption(option => option.setName('player').setDescription('Name or IP').setRequired(true))
                .addStringOption(option => option.setName('server').setDescription('Server id (default: this channel)').setRequired(false)),
            new SlashCommandBuilder()
                .setName('help')
                .setDescription('List the commands you can use, or explain one')
                .addStringOption(option => option.setName('command').setDescription('Command name').setRequired(false)),
            new SlashCommandBuilder()
                .setName('mc')
                .setDescription('Run a vbot command with your Discord rank')
                .addStringOption(option => option
                    .setName('command')
                    .setDescription('For example: filter list, whitelist add Steve')
                    .setRequired(true))
                .addStringOption(option => option
                    .setName('server')
                    .setDescription('Server id (default: the one linked to this channel)')
                    .setRequired(false))
        ].map(command => command.toJSON());

        try {
            if (this.config.guildId) {
                await this.client.application.commands.set(definitions, String(this.config.guildId));
            } else {
                await this.client.application.commands.set(definitions);
            }
            this.commandsRegistered = true;
            this.log?.info?.(`discord: registered ${definitions.length} slash command(s)`);
        } catch (error) {
            this.log?.warn?.(`discord: could not register slash commands: ${error.message}`);
        }
    }

    bots() {
        return typeof this.manager.list === 'function' ? this.manager.list() : [];
    }

    botFor(interaction, wanted) {
        if (!wanted) return this.channelBots.get(interaction.channelId) || null;
        return this.bots().find(bot => bot.id.toLowerCase() === String(wanted).toLowerCase()) || null;
    }

    missingBot(interaction, wanted) {
        if (!wanted) return 'This channel is not linked to a server; pass the server option.';
        return `No server "${wanted}". Available: ${this.bots().map(bot => bot.id).join(', ')}`;
    }

    // /auth: a Discord member can hand out ranks, but never one above their own,
    // so the roles stay the ceiling. Public takes the rank away again.
    grantRank(member, player, rankName) {
        const rank = this.rankFor(member);
        if (rank < LEVEL.TRUSTED) {
            return { ok: false, text: 'The Trusted role is required for /auth.' };
        }

        const wanted = parseLevel(rankName);
        if (wanted === null) return { ok: false, text: `Unknown rank "${rankName}".` };
        if (wanted > rank) {
            return {
                ok: false,
                text: `You cannot grant ${levelName(wanted)}; your Discord rank is ${levelName(rank)}.`
            };
        }

        const name = String(player || '').trim();
        if (!/^[A-Za-z0-9_.-]{1,16}$/.test(name)) {
            return { ok: false, text: 'That is not a Minecraft name.' };
        }

        const permissions = this.registry?.permissions;
        if (!permissions || typeof permissions.grant !== 'function') {
            return { ok: false, text: 'Permissions are not loaded.' };
        }

        // A rank below your own cannot be used to touch someone above you: a
        // Trusted member must not be able to strip an admin's rank.
        const current = typeof permissions.levelFor === 'function'
            ? permissions.levelFor({ name }) ?? LEVEL.PUBLIC
            : LEVEL.PUBLIC;
        if (current > rank) {
            return {
                ok: false,
                text: `${name} is ${levelName(current)}; you cannot change a rank above your own.`
            };
        }

        permissions.grant(name, wanted, `discord:${member?.user?.id ?? member?.id ?? 'unknown'}`);

        return {
            ok: true,
            text: wanted === LEVEL.PUBLIC
                ? `Removed ${name}'s rank.`
                : `Gave ${name} ${levelName(wanted)}.`
        };
    }

    // Every reply is an embed, so command output reads as a card instead of a
    // wall of one-off text: a title naming the command and server, the body in
    // a code block when it is a list, and red for anything that failed.
    resultEmbed({ label, bot = null, text = '', ok = true, by = null, color = null }) {
        const { EmbedBuilder } = this.discord;
        const body = String(text ?? '').trim() || 'No output.';
        const fenced = body.includes('\n') ? `\`\`\`\n${body}\n\`\`\`` : body;

        const embed = new EmbedBuilder()
            .setColor(color ?? (ok ? 0x57f287 : 0xed4245))
            .setTitle(`${label}${bot ? ` · ${bot.id}` : ''}`)
            .setDescription(fenced.slice(0, 4000))
            .setTimestamp();

        if (by) embed.setFooter({ text: `by ${by}` });
        return embed;
    }

    replyHelp(interaction) {
        const registry = this.registry;
        const ephemeral = this.discord.MessageFlags?.Ephemeral ?? 64;
        const fail = text => interaction.reply({
            embeds: [this.resultEmbed({ label: 'help', text, ok: false, by: interaction.user?.username })],
            flags: ephemeral
        });

        if (!registry) return fail('Commands are not loaded.');

        const rank = this.rankFor(interaction.member);
        const name = String(interaction.options.getString('command') || '').trim().toLowerCase();

        if (name) {
            const command = registry.find(name);
            if (!command) return fail(`No command "${name}".`);
            if (command.level > rank) {
                return fail(`${command.name} needs ${levelName(command.level)}; your Discord rank is ${levelName(rank)}.`);
            }

            return interaction.reply({
                embeds: [this.resultEmbed({
                    label: command.name,
                    text: `${command.usage || command.name}\n${command.description || 'no description'}\nrank: ${levelName(command.level)}`,
                    by: interaction.user?.username
                })],
                flags: ephemeral
            });
        }

        const available = registry.listFor(rank);
        if (!available.length) return fail('No commands for your rank.');

        const { EmbedBuilder } = this.discord;
        const embed = new EmbedBuilder()
            .setTitle('Commands')
            .setDescription(`${available.length} command(s) you can run as ${levelName(rank)}.`)
            .setColor(0x5865f2)
            .setTimestamp();

        for (const level of [LEVEL.PUBLIC, LEVEL.TRUSTED, LEVEL.ADMIN, LEVEL.OWNER]) {
            const group = available.filter(command => command.level === level);
            if (!group.length) continue;

            embed.addFields({
                name: levelName(level),
                value: group
                    .map(command => `**${command.name}** — ${command.description || 'no description'}`)
                    .join('\n')
                    .slice(0, 1024)
            });
        }

        return interaction.reply({ embeds: [embed], flags: ephemeral });
    }

    // Discord ranks map straight onto vbot's: the Trusted role is trusted, the
    // Admin role is admin, and the Owner role is owner. A user id in
    // discord.adminIds is treated as owner too, for the odd person who has to
    // run something without a role.
    rankFor(member) {
        const hasRole = id => Boolean(id) && Boolean(member?.roles?.cache?.has?.(String(id)));
        if (hasRole(this.config.ownerId)) return LEVEL.OWNER;

        const userId = String(member?.user?.id ?? member?.id ?? '');
        if (userId && (this.config.adminIds || []).map(String).includes(userId)) return LEVEL.OWNER;
        if (hasRole(this.config.adminId)) return LEVEL.ADMIN;
        if (hasRole(this.config.trustedId)) return LEVEL.TRUSTED;
        return LEVEL.PUBLIC;
    }

    // Runs a command from the same registry the game uses, with the Discord
    // rank instead of the player's stored rank. Replies are collected instead
    // of being sent into the server.
    async executeCommand(bot, member, text, rank = this.rankFor(member)) {
        const registry = this.registry;
        if (!registry || typeof registry.find !== 'function') {
            return { ok: false, text: 'Commands are not loaded.' };
        }

        let body = String(text || '').trim();
        const prefixes = (this.root?.bot?.prefixes || []).slice()
            .sort((a, b) => String(b).length - String(a).length);
        for (const prefix of prefixes) {
            if (body.toLowerCase().startsWith(String(prefix).toLowerCase())) {
                body = body.slice(String(prefix).length);
                break;
            }
        }
        body = body.replace(/^[!/ ]+/, '').trim();

        const [label, ...args] = body.split(/\s+/);
        if (!label) return { ok: false, text: 'Give a command, for example: filter list' };

        const command = registry.find(label);
        if (!command) return { ok: false, text: `Unknown command "${label}".` };
        if (command.level > rank) {
            return {
                ok: false,
                text: `${command.name} needs ${levelName(command.level)}; your Discord rank is ${levelName(rank)}.`
            };
        }

        const lines = [];
        const reply = value => {
            const line = plainText(value);
            if (line) lines.push(line);
        };

        const ctx = {
            bot,
            bots: registry.manager?.bots ?? this.manager?.bots ?? new Map([[bot.id, bot]]),
            client: bot.client,
            config: this.root,
            store: registry.store,
            permissions: registry.permissions,
            tokens: null,
            logger: bot.log ?? this.log,
            username: member?.displayName || member?.user?.username || 'discord',
            uuid: null,
            verified: false,
            trustedName: true,
            level: rank,
            levelName: levelName(rank),
            args,
            argString: args.join(' '),
            prefix: this.config.commandPrefix || '!',
            reply,
            replyPrivate: reply,
            clickToken: () => null,
            run: commandText => registry.runCommand(bot, commandText),
            source: 'discord'
        };

        try {
            await command.execute(ctx);
        } catch (error) {
            return { ok: false, text: `${command.name} failed: ${error.message}` };
        }

        return { ok: true, text: lines.join('\n') || `${command.name}: done.` };
    }

    async handleInteraction(interaction) {
        if (!interaction?.isChatInputCommand?.() || !this.ready) return;

        const { MessageFlags } = this.discord;
        const ephemeral = MessageFlags?.Ephemeral ?? 64;
        const reply = content => interaction.reply({ content, flags: ephemeral });

        if (interaction.commandName === 'servers') {
            const embed = new this.discord.EmbedBuilder()
                .setTitle('Servers')
                .setColor(0x5865f2)
                .setTimestamp();

            for (const bot of this.bots()) {
                const online = bot.state === 'ready';
                const names = online ? onlineNames(bot) : [];
                embed.addFields({
                    name: `${bot.id}${online ? '' : ' (offline)'}`,
                    value: `${names.length} player${names.length === 1 ? '' : 's'} online` +
                        (names.length ? `\n${names.slice(0, 20).join(', ')}` : ''),
                    inline: false
                });
            }
            return interaction.reply({ embeds: [embed] });
        }

        if (interaction.commandName === 'players') {
            const wanted = interaction.options.getString('server');
            const linked = this.channelBots.get(interaction.channelId);
            const bot = wanted
                ? this.bots().find(candidate => candidate.id.toLowerCase() === wanted.toLowerCase())
                : linked;

            if (!bot) {
                return interaction.reply({
                    embeds: [this.resultEmbed({
                        label: 'players',
                        text: this.missingBot(interaction, wanted),
                        ok: false,
                        by: interaction.user?.username
                    })],
                    flags: ephemeral
                });
            }

            const names = onlineNames(bot);
            return interaction.reply({
                embeds: [this.resultEmbed({
                    label: 'players',
                    bot,
                    text: names.length
                        ? `${names.length} online\n${names.slice(0, 50).join(', ')}`
                        : 'No players online.',
                    by: interaction.user?.username
                })],
                flags: ephemeral
            });
        }

        if (interaction.commandName === 'auth') {
            const result = this.grantRank(
                interaction.member,
                interaction.options.getString('player'),
                interaction.options.getString('rank')
            );
            if (result.ok) this.log?.info?.(`discord: ${interaction.user?.tag || interaction.user?.id} ${result.text}`);
            return interaction.reply({
                embeds: [this.resultEmbed({
                    label: 'auth',
                    text: result.text,
                    ok: result.ok,
                    by: interaction.user?.username
                })],
                flags: ephemeral
            });
        }

        if (interaction.commandName === 'filter' || interaction.commandName === 'whitelist' || interaction.commandName === 'alts') {
            const wanted = interaction.options.getString('server');
            const bot = this.botFor(interaction, wanted);
            if (!bot) return reply(this.missingBot(interaction, wanted));

            const action = interaction.options.getString('action');
            const value = interaction.options.getString('value');
            const player = interaction.options.getString('player');
            const text = [interaction.commandName, action, value, player]
                .filter(part => part !== null && part !== undefined && String(part).trim() !== '')
                .join(' ');

            const result = await this.executeCommand(bot, interaction.member, text);
            return interaction.reply({
                embeds: [this.resultEmbed({
                    label: interaction.commandName,
                    bot,
                    text: result.text,
                    ok: result.ok,
                    by: interaction.user?.username
                })],
                flags: ephemeral
            });
        }

        if (interaction.commandName === 'help') {
            return this.replyHelp(interaction);
        }

        if (interaction.commandName === 'mc') {
            // /mc is a staff tool: a public-level command such as `cb` would
            // otherwise hand raw server commands to every member.
            if (this.rankFor(interaction.member) < LEVEL.TRUSTED) {
                return interaction.reply({
                    embeds: [this.resultEmbed({ label: 'mc', text: 'The Trusted role is required for /mc.', ok: false })],
                    flags: ephemeral
                });
            }

            const text = interaction.options.getString('command') || '';
            const wanted = interaction.options.getString('server');
            const linked = this.channelBots.get(interaction.channelId);
            const bot = wanted
                ? this.bots().find(candidate => candidate.id.toLowerCase() === wanted.toLowerCase())
                : linked;

            if (!bot) {
                return interaction.reply({
                    embeds: [this.resultEmbed({ label: 'mc', text: this.missingBot(interaction, wanted), ok: false })],
                    flags: ephemeral
                });
            }

            const result = await this.executeCommand(bot, interaction.member, text);
            return interaction.reply({
                embeds: [this.resultEmbed({
                    label: 'mc',
                    bot,
                    text: result.text,
                    ok: result.ok,
                    by: interaction.user?.username
                })],
                flags: ephemeral
            });
        }
    }

    destroy() {
        if (this.manager) {
            this.manager.removeListener?.('chat', this.onMinecraftChat);
            this.manager.removeListener?.('disconnect', this.onBotDisconnect);
        }

        this.flushAll();

        for (const relay of this.relays.values()) {
            relay.stopped = true;
            if (relay.timer) clearTimeout(relay.timer);
            relay.timer = null;
            relay.buffer.length = 0;
        }

        this.relays.clear();
        this.channelBots.clear();
        try { this.client?.destroy(); } catch { /* already gone */ }
        this.client = null;
        this.started = false;
        this.commandsRegistered = false;
    }
}

function plainText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(plainText).join('');
    if (!value || typeof value !== 'object') return '';
    const own = typeof value.text === 'string' ? value.text : '';
    return own + plainText(value.extra || []);
}

function createDiscordBridge({ config, manager, logger, registry }) {
    if (config?.discord?.enabled !== true) return null;
    return new DiscordBridge({ config, manager, logger, registry });
}

module.exports = {
    DiscordBridge,
    ansiBlock,
    channelFor,
    createDiscordBridge,
    describeMessage,
    discordComponent,
    formatMentions,
    linkParts,
    stripMarkdown,
    takeBatch,
    toDiscordAnsi
};
