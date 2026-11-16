'use strict';

// The Discord bridge posts game chat and connection events into a channel. It
// only writes: reading Discord would need a bot token and a gateway connection,
// which is a different feature.

module.exports = {
    name: 'discord',
    description: 'Check the Discord relay, or send it a test message',
    usage: 'discord [status|test]',
    level: 'admin',

    async execute(ctx) {
        const bridge = ctx.bot.discord;
        const configured = Boolean(ctx.config?.discord?.webhookUrl);

        if (!bridge || !bridge.enabled) {
            ctx.reply(configured
                ? 'Discord is set up with something that is not a webhook URL.'
                : 'No Discord webhook is configured (discord.webhookUrl).');
            return;
        }

        const first = String(ctx.args[0] || 'status').toLowerCase();

        if (first === 'test') {
            const ok = await bridge.event(`Test message from **${ctx.bot.server.username}** (${ctx.bot.id}).`);
            ctx.reply(ok ? 'Posted a test message to Discord.' : 'Discord did not accept the test message; see the log.');
            return;
        }

        if (first !== 'status') {
            ctx.reply(`Usage: ${ctx.prefix}discord [status|test]`);
            return;
        }

        const status = bridge.status();
        ctx.reply(
            `Discord: ${status.sent} sent, ${status.failed} failed, ${status.queued} queued` +
            (status.dropped ? `, ${status.dropped} dropped` : '') +
            (status.lastError ? ` (last error: ${status.lastError})` : '')
        );
    }
};
