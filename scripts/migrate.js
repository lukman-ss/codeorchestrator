import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { existsSync, copyFileSync } from 'node:fs';
import { DATABASE_PATH } from '../src/config.js';

export function runMigration(targetPath = DATABASE_PATH) {
  if (!existsSync(targetPath)) {
    throw new Error(`Database file does not exist at ${targetPath}`);
  }

  // Auto-backup before applying
  const backupPath = `${targetPath}.bak-${Date.now()}`;
  copyFileSync(targetPath, backupPath);
  console.log(`[Migrate] Pre-migration backup saved to: ${backupPath}`);

  const db = new Database(targetPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');

  const beforeProjects = db.prepare('SELECT count(*) as c FROM projects').get().c;
  const beforeSessions = db.prepare('SELECT count(*) as c FROM sessions').get().c;
  console.log(`[Migrate] Current counts - Projects: ${beforeProjects}, Sessions: ${beforeSessions}`);

  db.transaction(() => {
    // Check if session rebuild is needed
    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all();
    const hasSessionType = sessionCols.some(c => c.name === 'session_type');
    const projCol = sessionCols.find(c => c.name === 'project_id');
    const needsRebuild = !hasSessionType || (projCol && projCol.notnull === 1);

    if (needsRebuild) {
      console.log('[Migrate] Rebuilding sessions table for nullable project_id and standalone support...');
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
          id,
          project_id,
          opencode_session_id,
          'project' AS session_type,
          title,
          model,
          'active' AS status,
          '{}' AS metadata_json,
          created_at,
          updated_at
        FROM sessions;

        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;

        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(session_type);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      `);
    }

    // Projects columns
    const projCols = db.prepare('PRAGMA table_info(projects)').all().map(c => c.name);
    if (!projCols.includes('is_test')) {
      console.log('[Migrate] Adding is_test column to projects...');
      db.exec('ALTER TABLE projects ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0');
    }
    if (!projCols.includes('metadata_json')) {
      console.log('[Migrate] Adding metadata_json column to projects...');
      db.exec("ALTER TABLE projects ADD COLUMN metadata_json TEXT DEFAULT '{}'");
    }

    // Session messages
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        content TEXT NOT NULL,
        opencode_session_id TEXT,
        metadata_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_projects_test ON projects(is_test);
    `);
  })();

  db.pragma('foreign_keys = ON');
  const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
  if (fkCheck.length > 0) {
    db.close();
    throw new Error(`[Migrate] Foreign key violation detected: ${JSON.stringify(fkCheck)}`);
  }

  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    db.close();
    throw new Error(`[Migrate] Integrity check failed: ${JSON.stringify(integrity)}`);
  }

  const afterProjects = db.prepare('SELECT count(*) as c FROM projects').get().c;
  const afterSessions = db.prepare('SELECT count(*) as c FROM sessions').get().c;
  console.log(`[Migrate] Post-migration counts - Projects: ${afterProjects}, Sessions: ${afterSessions}`);

  db.close();
  console.log('[Migrate] Migration completed successfully.');
  return { backupPath, beforeSessions, afterSessions };
}

if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  const customDb = process.argv[2] ? resolve(process.argv[2]) : DATABASE_PATH;
  runMigration(customDb);
}
