'use strict';

// Two-way Discord bridge.
//
//   Minecraft -> Discord: every player chat line is posted to that server's
//   channel, one message per conversation burst.
//
//   Discord -> Minecraft: messages in that channel are shown in game with a
//   tellraw, through the core when it is ready and as chat when it is not.
//
//   Slash commands: /servers, /players, /say (say needs Manage Server or an id
//   in discord.adminIds).
//
// discord.js is loaded lazily, so the bot runs and the selfcheck passes when
// the dependency or the token is missing.

const tellraw = require('./minecraft/tellraw');

const RELAY_INTERVAL_MS = 900;
const RELAY_MAX_BUFFER = 50;
const RELAY_LIMIT = 1900;
const ECHO_TTL_MS = 15000;
const MC_LIMIT = 256;

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

function formatMinecraftLine({ server, username, message }) {
    const name = oneLine(username, 64) || '?';
    const body = oneLine(message, RELAY_LIMIT);
    return `[${server}] ${name}: ${body}`.slice(0, RELAY_LIMIT);
}

function discordComponent({ author, message }) {
    return [
        { text: '[Discord] ', color: 'blue' },
        { text: oneLine(author, 64) || '?', color: 'aqua' },
        { text: ': ', color: 'gray' },
        { text: oneLine(message, MC_LIMIT), color: 'white' }
    ];
}

function onlineNames(bot) {
    const names = [];
    if (bot?.online instanceof Map) {
        for (const player of bot.online.values()) if (player?.name) names.push(player.name);
    }
    return names.sort((a, b) => a.localeCompare(b));
}

class DiscordBridge {
    constructor({ config, manager, logger }) {
        this.root = config;
        this.config = config?.discord || {};
        this.manager = manager;
        this.log = logger;
        this.client = null;
        this.discord = null;
        this.started = false;
        this.commandsRegistered = false;
        this.relays = new Map();      // server id -> relay
        this.channelBots = new Map(); // channel id -> bot
        this.onMinecraftChat = (bot, event) => this.handleMinecraftChat(bot, event);
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

            const relay = {
                bot,
                channelId,
                buffer: [],
                timer: null,
                flushing: false,
                echoes: new Map()
            };
            this.relays.set(bot.id, relay);
            this.channelBots.set(channelId, bot);
        }
    }

    isCommand(text) {
        const prefixes = this.root?.bot?.prefixes || [];
        const value = String(text || '').toLowerCase();
        return prefixes.some(prefix => value.startsWith(String(prefix).toLowerCase()));
    }

    noteEcho(relay, text) {
        if (!relay) return;
        relay.echoes.set(String(text), Date.now() + ECHO_TTL_MS);
        if (relay.echoes.size > 50) {
            const now = Date.now();
            for (const [key, expiry] of relay.echoes) {
                if (expiry < now) relay.echoes.delete(key);
            }
            while (relay.echoes.size > 50) {
                relay.echoes.delete(relay.echoes.keys().next().value);
            }
        }
    }

    consumeEcho(relay, text) {
        if (!relay) return false;
        const now = Date.now();
        for (const [key, expiry] of relay.echoes) {
            if (expiry < now) {
                relay.echoes.delete(key);
                continue;
            }
            if (text === key || String(text).endsWith(key)) {
                relay.echoes.delete(key);
                return true;
            }
        }
        return false;
    }

    handleMinecraftChat(bot, event) {
        if (!this.ready || this.config.relay?.chat === false) return;
        const parsed = event?.parsed;
        if (!parsed?.username || !parsed?.message) return;
        if (parsed.username.toLowerCase() === String(bot.server?.username || '').toLowerCase()) return;
        if (this.isCommand(parsed.message)) return;

        const relay = this.relays.get(bot.id);
        if (!relay) return;
        if (this.consumeEcho(relay, parsed.message)) return;

        relay.buffer.push(formatMinecraftLine({
            server: bot.id,
            username: parsed.username,
            message: parsed.message
        }));
        while (relay.buffer.length > RELAY_MAX_BUFFER) relay.buffer.shift();

        if (!relay.timer) {
            relay.timer = setTimeout(() => {
                relay.timer = null;
                void this.flush(relay);
            }, RELAY_INTERVAL_MS);
            relay.timer.unref?.();
        }
    }

    async flush(relay) {
        if (relay.flushing || !relay.buffer.length || !this.ready) return;
        relay.flushing = true;

        try {
            const channel = this.client.channels.cache.get(relay.channelId)
                || await this.client.channels.fetch(relay.channelId).catch(() => null);
            if (!channel || typeof channel.send !== 'function') {
                this.log?.warn?.(`discord: channel ${relay.channelId} is not available; dropping ${relay.buffer.length} line(s)`);
                relay.buffer.length = 0;
                return;
            }

            while (relay.buffer.length) {
                const batch = [];
                let size = 0;
                while (relay.buffer.length) {
                    const line = relay.buffer[0];
                    if (batch.length && size + line.length + 1 > RELAY_LIMIT) break;
                    batch.push(relay.buffer.shift());
                    size += line.length + 1;
                }
                if (!batch.length) break;
                await channel.send({
                    content: batch.join('\n').slice(0, RELAY_LIMIT),
                    allowedMentions: { parse: [] }
                });
            }
        } catch (error) {
            this.log?.warn?.(`discord: relay send failed: ${error.message}`);
            relay.buffer.length = 0;
        } finally {
            relay.flushing = false;
        }
    }

    async handleDiscordMessage(message) {
        if (!this.ready || this.config.relay?.discord === false) return;
        if (!message?.guild || message.author?.bot) return;

        const content = String(message.content || '').trim();
        if (!content) return;
        if (content.startsWith(String(this.config.commandPrefix || '!'))) return;

        const bot = this.channelBots.get(message.channelId);
        if (!bot) return;

        const relay = this.relays.get(bot.id);
        const author = message.member?.displayName || message.author?.username || 'Discord';
        this.noteEcho(relay, content);
        this.sendToMinecraft(bot, author, content);
    }

    sendToMinecraft(bot, author, text) {
        if (!bot || bot.state !== 'ready') return false;
        const component = discordComponent({ author, message: text });
        const payload = tellraw.payload(component, bot.client?.version || null);
        // A tellraw needs a command block when the bot is not opped in chat; the
        // plain chat line is the last resort.
        const sent = bot.chat(`/tellraw @a ${payload}`);
        if (sent !== false) return true;
        return bot.sendChat(`[Discord] ${oneLine(author, 64)}: ${oneLine(text, MC_LIMIT)}`) !== false;
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
                .setName('say')
                .setDescription('Send a message into Minecraft')
                .addStringOption(option => option.setName('server').setDescription('Server id, or all').setRequired(true))
                .addStringOption(option => option.setName('message').setDescription('What to say').setRequired(true))
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

    async handleInteraction(interaction) {
        if (!interaction?.isChatInputCommand?.() || !this.ready) return;

        const { MessageFlags, PermissionFlagsBits } = this.discord;
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

            if (!bot) return reply(`No server "${wanted || 'linked to this channel'}".`);
            const names = onlineNames(bot);
            return reply(names.length
                ? `${bot.id} (${names.length}): ${names.slice(0, 50).join(', ')}`
                : `${bot.id}: no players online.`);
        }

        if (interaction.commandName === 'say') {
            const allowed = interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)
                || (this.config.adminIds || []).includes(interaction.user.id);
            if (!allowed) return reply('You need Manage Server to use /say.');

            const server = String(interaction.options.getString('server') || 'all').toLowerCase();
            const message = interaction.options.getString('message') || '';
            const targets = server === 'all'
                ? this.bots()
                : this.bots().filter(bot => bot.id.toLowerCase() === server);

            if (!targets.length) return reply(`No server "${server}".`);
            let sent = 0;
            for (const bot of targets) {
                if (this.sendToMinecraft(bot, interaction.member?.displayName || interaction.user.username, message)) {
                    this.noteEcho(this.relays.get(bot.id), message);
                    sent += 1;
                }
            }
            return reply(sent ? `Sent to ${sent} server(s).` : 'No connected server could take it.');
        }
    }

    destroy() {
        if (this.manager) this.manager.removeListener?.('chat', this.onMinecraftChat);
        for (const relay of this.relays.values()) {
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

function createDiscordBridge({ config, manager, logger }) {
    if (config?.discord?.enabled !== true) return null;
    return new DiscordBridge({ config, manager, logger });
}

module.exports = {
    DiscordBridge,
    createDiscordBridge,
    channelFor,
    discordComponent,
    formatMinecraftLine
};
