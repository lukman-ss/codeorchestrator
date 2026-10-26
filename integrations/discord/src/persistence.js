import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from './config.js';

export class PersistenceStore {
  constructor(dbPath = config.dbPath) {
    this.dbPath = dbPath;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discord_executions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        project_id TEXT,
        project_slug TEXT,
        prompt_snippet TEXT,
        status TEXT NOT NULL,
        last_event_sequence INTEGER DEFAULT 0,
        last_event_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_discord_executions_status ON discord_executions(status);
      CREATE INDEX IF NOT EXISTS idx_discord_executions_channel ON discord_executions(channel_id);
    `);
  }

  saveExecution(item) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO discord_executions
      (id, kind, guild_id, channel_id, user_id, message_id, project_id, project_slug, prompt_snippet, status, last_event_sequence, last_event_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    stmt.run(
      item.id,
      item.kind || 'task',
      item.guildId,
      item.channelId,
      item.userId,
      item.messageId,
      item.projectId || null,
      item.projectSlug || null,
      item.promptSnippet || null,
      item.status || 'queued',
      item.lastEventSequence || 0,
      item.lastEventId || null
    );
    return this.getExecution(item.id);
  }

  getExecution(id) {
    return this.db.prepare('SELECT * FROM discord_executions WHERE id = ?').get(id);
  }

  updateExecution(id, updates = {}) {
    const sets = [];
    const vals = [];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      vals.push(updates.status);
      if (['completed', 'failed', 'cancelled', 'partially_completed', 'interrupted'].includes(updates.status)) {
        sets.push("completed_at = COALESCE(completed_at, datetime('now'))");
      }
    }
    if (updates.messageId !== undefined) {
      sets.push('message_id = ?');
      vals.push(updates.messageId);
    }
    if (updates.lastEventSequence !== undefined) {
      sets.push('last_event_sequence = ?');
      vals.push(updates.lastEventSequence);
    }
    if (updates.lastEventId !== undefined) {
      sets.push('last_event_id = ?');
      vals.push(updates.lastEventId);
    }

    sets.push("updated_at = datetime('now')");
    vals.push(id);

    const sql = `UPDATE discord_executions SET ${sets.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...vals);
    return this.getExecution(id);
  }

  getActiveExecutions() {
    return this.db.prepare(
      `SELECT * FROM discord_executions WHERE status NOT IN ('completed', 'failed', 'cancelled', 'partially_completed', 'interrupted') ORDER BY created_at ASC`
    ).all();
  }

  getSessionExecution(id) {
    return this.db.prepare("SELECT * FROM discord_executions WHERE id = ?").get(id);
  }

  listUserSessions(userId) {
    return this.db.prepare("SELECT * FROM discord_executions WHERE user_id = ? AND kind = 'session' ORDER BY updated_at DESC").all(userId);
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }
}

export default new PersistenceStore();
