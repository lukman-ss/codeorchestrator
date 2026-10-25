import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DATABASE_PATH } from '../config.js';
import { migrations as allMigrations, currentSchemaVersion } from './migrations.js';

mkdirSync(dirname(DATABASE_PATH), { recursive: true });

const db = new Database(DATABASE_PATH, { timeout: 5000 });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const initMigrations = () => {
  db.prepare('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime(\'now\')))').run();
  const current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v || 0;
  if (current < currentSchemaVersion) {
    for (let i = current; i < currentSchemaVersion; i++) {
      const m = allMigrations[i];
      if (m) db.exec(m);
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(currentSchemaVersion);
  }
};

const baseTables = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    workspace_path TEXT NOT NULL UNIQUE,
    repo_url TEXT,
    default_model TEXT DEFAULT '9router/ayce-combo',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    opencode_session_id TEXT,
    title TEXT,
    model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    prompt TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),
    pid INTEGER,
    exit_code INTEGER,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(task_id, sequence)
  )`
];

export const init = () => {
  const tx = db.transaction(() => {
    for (const sql of baseTables) db.exec(sql);
  });
  tx();
  initMigrations();
  const txMigrations = db.transaction(() => {
    for (const sql of allMigrations) db.exec(sql);
  });
  txMigrations();
};

export const checkpoint = () => {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {}
};

export const close = () => {
  try {
    checkpoint();
    db.close();
  } catch {}
};

export const dbGet = (sql, params) => db.prepare(sql).all(...(params || []));
export const dbRun = (sql, params) => db.prepare(sql).run(...(params || []));
export const dbGetOne = (sql, params) => db.prepare(sql).get(...(params || []));
export const dbPrepare = (sql) => db.prepare(sql);
export default db;
