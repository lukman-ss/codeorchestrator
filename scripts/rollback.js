import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { DATABASE_PATH } from '../src/config.js';

export function rollbackMigration(targetPath = DATABASE_PATH, backupPath = null) {
  if (backupPath) {
    if (!existsSync(backupPath)) throw new Error(`Backup file not found at: ${backupPath}`);
    copyFileSync(backupPath, targetPath);
    console.log(`[Rollback] Restored database from backup: ${backupPath}`);
    return;
  }

  // Schema-level rollback: convert sessions back to NOT NULL project_id schema
  const db = new Database(targetPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');

  // Any standalone sessions must either be linked or purged before reverting to NOT NULL
  const standalone = db.prepare("SELECT count(*) as c FROM sessions WHERE project_id IS NULL OR session_type = 'standalone'").get().c;
  if (standalone > 0) {
    console.warn(`[Rollback] Warning: Found ${standalone} standalone session(s). Purging standalone sessions to satisfy NOT NULL constraint.`);
    db.prepare("DELETE FROM sessions WHERE project_id IS NULL OR session_type = 'standalone'").run();
  }

  db.transaction(() => {
    db.exec(`
      CREATE TABLE sessions_old (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        opencode_session_id TEXT,
        title TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO sessions_old (id, project_id, opencode_session_id, title, model, created_at, updated_at)
      SELECT id, project_id, opencode_session_id, title, model, created_at, updated_at
      FROM sessions;

      DROP TABLE sessions;
      ALTER TABLE sessions_old RENAME TO sessions;
    `);
  })();

  db.pragma('foreign_keys = ON');
  const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
  const integrity = db.prepare('PRAGMA integrity_check').all();
  db.close();

  if (fkCheck.length > 0) throw new Error(`Rollback FK check failed: ${JSON.stringify(fkCheck)}`);
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error(`Rollback integrity failed: ${JSON.stringify(integrity)}`);

  console.log('[Rollback] Reverted sessions table to original schema.');
}

if (process.argv[1] && process.argv[1].endsWith('rollback.js')) {
  const customDb = process.argv[2] ? resolve(process.argv[2]) : DATABASE_PATH;
  const backup = process.argv[3] ? resolve(process.argv[3]) : null;
  rollbackMigration(customDb, backup);
}
