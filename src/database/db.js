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
    is_test INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    opencode_session_id TEXT,
    session_type TEXT NOT NULL DEFAULT 'project' CHECK(session_type IN ('standalone','project')),
    title TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('created','active','idle','interrupted','closed')),
    user_id TEXT,
    runtime_path TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK((session_type = 'standalone' AND project_id IS NULL) OR (session_type = 'project' AND project_id IS NOT NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS session_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    opencode_session_id TEXT,
    metadata_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

const ensureIndexes = () => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(session_type);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_projects_test ON projects(is_test);
  `);
};

export const init = () => {
  const sessionCols = db.prepare('PRAGMA table_info(sessions)').all();
  if (sessionCols.length > 0) {
    const hasSessionType = sessionCols.some(c => c.name === 'session_type');
    const projCol = sessionCols.find(c => c.name === 'project_id');
    if (!hasSessionType || (projCol && projCol.notnull === 1)) {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE sessions_new (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            opencode_session_id TEXT,
            session_type TEXT NOT NULL DEFAULT 'project' CHECK(session_type IN ('standalone','project')),
            title TEXT,
            model TEXT,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('created','active','idle','interrupted','closed')),
            user_id TEXT,
            runtime_path TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            CHECK((session_type = 'standalone' AND project_id IS NULL) OR (session_type = 'project' AND project_id IS NOT NULL))
          );
          INSERT INTO sessions_new (
            id, project_id, opencode_session_id, session_type, title, model, status, metadata_json, created_at, updated_at
          )
          SELECT
            id, project_id, opencode_session_id, 'project' AS session_type, title, model, 'active' AS status, '{}' AS metadata_json, created_at, updated_at
          FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_new RENAME TO sessions;
        `);
      })();
      db.pragma('foreign_keys = ON');
    }
  }

  const tx = db.transaction(() => {
    for (const sql of baseTables) db.exec(sql);
  });
  tx();
  initMigrations();
  const txMigrations = db.transaction(() => {
    for (const sql of allMigrations) db.exec(sql);
  });
  txMigrations();
  ensureIndexes();
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
