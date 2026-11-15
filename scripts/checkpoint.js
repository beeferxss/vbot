'use strict';

// Flushes the write-ahead log into the database file so the committed
// data/vbot.sqlite is complete on its own.

const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/db');

const ROOT = path.join(__dirname, '..');
const dbPath = path.resolve(ROOT, process.env.VBOT_DB || 'data/vbot.sqlite');

if (!fs.existsSync(dbPath)) {
    console.log(`no database at ${dbPath}, nothing to checkpoint`);
    process.exit(0);
}

const store = new Store(dbPath).open();
store.checkpoint();
store.close();

console.log(`checkpointed ${dbPath} (${fs.statSync(dbPath).size} bytes)`);
