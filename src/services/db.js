'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// Use :memory: in test environment to avoid touching the filesystem
const DB_PATH = process.env.NODE_ENV === 'test'
  ? ':memory:'
  : (process.env.DB_PATH || path.join(__dirname, '../../data/jobs.db'));

if (DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);

// WAL mode: faster writes, readers don't block writers
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    jobId        TEXT PRIMARY KEY,
    status       TEXT    NOT NULL DEFAULT 'queued',
    percent      INTEGER NOT NULL DEFAULT 0,
    filename     TEXT    NOT NULL,
    sizeBytes    INTEGER NOT NULL,
    inputPath    TEXT    NOT NULL,
    outputPath   TEXT    NOT NULL,
    targetFormat TEXT    NOT NULL DEFAULT 'avi',
    createdAt    INTEGER NOT NULL,
    error        TEXT
  )
`);

module.exports = db;
