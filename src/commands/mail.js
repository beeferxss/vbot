'use strict';

// Offline messages, kept in the database so they outlive a session. A mailbox
// follows the name the way ranks do; `/mail` on its own says whether anything
// is waiting, and `read` marks what it shows as read.

const MAX_LISTED = 10;
const MAX_MESSAGE = 400;
const NAME = /^[A-Za-z0-9_.-]{1,16}$/;

function stamp(ms) {
    if (!ms) return 'unknown';
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function line(mail, index) {
    const status = mail.read_at ? 'read' : 'unread';
    return `[${index + 1}] ${status} | ${mail.from_name} (${stamp(mail.sent_at)}): ${mail.text}`;
}

module.exports = {
    name: 'mail',
    description: 'Offline messages: send, read, list or clear them',
    usage: 'mail <send <player> <message>|read|list|clear [all]>',
    level: 'public',

    async execute(ctx) {
        const store = ctx.store;
        if (!store || typeof store.sendMail !== 'function') {
            return ctx.reply('Mail storage is not loaded.');
        }

        const usage = `Usage: ${ctx.prefix}${this.usage}`;
        const [sub, ...rest] = ctx.args;
        const who = ctx.username || '';

        if (!sub) {
            const unread = store.unreadMailCount(who);
            return ctx.reply(unread
                ? `${unread} unread message(s). ${ctx.prefix}mail read\n${usage}`
                : `No unread messages. ${usage}`);
        }

        if (sub === 'send') {
            const to = rest[0];
            const text = rest.slice(1).join(' ').trim();
            if (!to || !text) return ctx.reply(`Usage: ${ctx.prefix}mail send <player> <message>`);
            if (!NAME.test(to)) return ctx.reply(`That is not a Minecraft name: ${to}`);
            if (text.length > MAX_MESSAGE) {
                return ctx.reply(`Keep the message under ${MAX_MESSAGE} characters.`);
            }
            if (!store.sendMail(who, to, text)) return ctx.reply('The message could not be stored.');
            return ctx.reply(`Message sent to ${to}.`);
        }

        if (sub === 'read') {
            const unread = store.mailsFor(who).filter(mail => !mail.read_at);
            if (!unread.length) return ctx.reply('No unread messages.');
            const shown = unread.slice(0, MAX_LISTED).map(line);
            if (unread.length > MAX_LISTED) shown.push(`... and ${unread.length - MAX_LISTED} more`);
            store.markMailsRead(who);
            return ctx.reply(`Unread messages:\n${shown.join('\n')}`);
        }

        if (sub === 'list') {
            const all = store.mailsFor(who);
            if (!all.length) return ctx.reply('No messages.');
            const shown = all.slice(-MAX_LISTED).map((mail, index) => line(mail, index));
            if (all.length > MAX_LISTED) shown.unshift(`... showing the last ${MAX_LISTED} of ${all.length}`);
            return ctx.reply(`Your messages:\n${shown.join('\n')}`);
        }

        if (sub === 'clear') {
            const all = String(rest[0] || '').toLowerCase() === 'all';
            const cleared = store.clearMails(who, { all });
            return ctx.reply(cleared
                ? `Cleared ${cleared} ${all ? '' : 'read '}message(s).`
                : `No ${all ? '' : 'read '}messages to clear.`);
        }

        return ctx.reply(usage);
    }
};
