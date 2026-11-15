'use strict';

const LEVELS = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100
};

class Logger {
    constructor({ level = 'info', scope = null } = {}) {
        this.level = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level];
        this.scope = scope;
    }

    child(scope) {
        const child = new Logger({});
        child.level = this.level;
        child.scope = scope;
        return child;
    }

    enabled(level) {
        return LEVELS[level] >= this.level;
    }

    write(level, args) {
        if (!this.enabled(level)) return;
        const stamp = new Date().toISOString().slice(11, 23);
        const scope = this.scope ? ` [${this.scope}]` : '';
        const line = `${stamp} ${level.toUpperCase().padEnd(5)}${scope}`;
        const sink = level === 'error' || level === 'warn' ? console.error : console.log;
        sink(line, ...args);
    }

    debug(...args) { this.write('debug', args); }
    info(...args) { this.write('info', args); }
    warn(...args) { this.write('warn', args); }
    error(...args) { this.write('error', args); }
}

module.exports = { Logger, LEVELS };
