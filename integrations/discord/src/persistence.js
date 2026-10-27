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

      CREATE TABLE IF NOT EXISTS discord_conversations (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        discord_user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project_id TEXT,
        conversation_type TEXT NOT NULL DEFAULT 'standalone' CHECK(conversation_type IN ('standalone', 'project')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'closed', 'archived')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_discord_conv_scope ON discord_conversations(guild_id, channel_id, discord_user_id, status);
      CREATE INDEX IF NOT EXISTS idx_discord_conv_thread ON discord_conversations(thread_id, discord_user_id, status);
      CREATE INDEX IF NOT EXISTS idx_discord_conv_session ON discord_conversations(session_id);

      CREATE TABLE IF NOT EXISTS discord_session_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        discord_message_id TEXT NOT NULL UNIQUE,
        referenced_message_id TEXT,
        message_role TEXT NOT NULL CHECK(message_role IN ('user', 'assistant', 'system')),
        status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('received', 'queued', 'running', 'completed', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_discord_msg_discord_id ON discord_session_messages(discord_message_id);
      CREATE INDEX IF NOT EXISTS idx_discord_msg_conv ON discord_session_messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_discord_msg_session ON discord_session_messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_discord_msg_status ON discord_session_messages(status);
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

  // Conversation mapping methods
  createConversation(item) {
    const stmt = this.db.prepare(`
      INSERT INTO discord_conversations
      (id, guild_id, channel_id, thread_id, discord_user_id, session_id, project_id, conversation_type, status, created_at, updated_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
    `);
    stmt.run(
      item.id,
      item.guildId,
      item.channelId,
      item.threadId || null,
      item.discordUserId,
      item.sessionId,
      item.projectId || null,
      item.conversationType || 'standalone',
      item.status || 'active'
    );
    return this.getConversation(item.id);
  }

  getActiveConversation({ guildId, channelId, threadId = null, discordUserId }) {
    if (threadId) {
      return this.db.prepare(`
        SELECT * FROM discord_conversations
        WHERE guild_id = ? AND thread_id = ? AND discord_user_id = ? AND status = 'active'
        ORDER BY last_activity_at DESC, updated_at DESC LIMIT 1
      `).get(guildId, threadId, discordUserId);
    }
    return this.db.prepare(`
      SELECT * FROM discord_conversations
      WHERE guild_id = ? AND channel_id = ? AND (thread_id IS NULL OR thread_id = '') AND discord_user_id = ? AND status = 'active'
      ORDER BY last_activity_at DESC, updated_at DESC LIMIT 1
    `).get(guildId, channelId, discordUserId);
  }

  getConversation(id) {
    return this.db.prepare('SELECT * FROM discord_conversations WHERE id = ?').get(id);
  }

  getConversationBySessionId(sessionId) {
    return this.db.prepare('SELECT * FROM discord_conversations WHERE session_id = ? ORDER BY last_activity_at DESC LIMIT 1').get(sessionId);
  }

  updateConversation(id, updates = {}) {
    const sets = [];
    const vals = [];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      vals.push(updates.status);
    }
    if (updates.projectId !== undefined) {
      sets.push('project_id = ?');
      vals.push(updates.projectId);
    }
    if (updates.last_activity_at !== undefined) {
      sets.push('last_activity_at = ?');
      vals.push(updates.last_activity_at);
    } else {
      sets.push("last_activity_at = datetime('now')");
    }

    sets.push("updated_at = datetime('now')");
    vals.push(id);

    const sql = `UPDATE discord_conversations SET ${sets.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...vals);
    return this.getConversation(id);
  }

  closeConversation(id) {
    return this.updateConversation(id, { status: 'closed' });
  }

  closeActiveConversation({ guildId, channelId, threadId = null, discordUserId }) {
    const active = this.getActiveConversation({ guildId, channelId, threadId, discordUserId });
    if (active) {
      return this.closeConversation(active.id);
    }
    return null;
  }

  // Discord message mapping & idempotency methods
  saveSessionMessage(item) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO discord_session_messages
      (id, conversation_id, session_id, discord_message_id, referenced_message_id, message_role, status, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(
      item.id,
      item.conversationId,
      item.sessionId,
      item.discordMessageId,
      item.referencedMessageId || null,
      item.messageRole,
      item.status || 'completed',
      item.error || null
    );
    return this.getSessionMessage(item.discordMessageId);
  }

  getSessionMessage(discordMessageId) {
    return this.db.prepare('SELECT * FROM discord_session_messages WHERE discord_message_id = ?').get(discordMessageId);
  }

  updateSessionMessage(discordMessageId, updates = {}) {
    const sets = [];
    const vals = [];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      vals.push(updates.status);
    }
    if (updates.error !== undefined) {
      sets.push('error = ?');
      vals.push(updates.error);
    }

    if (!sets.length) return this.getSessionMessage(discordMessageId);

    vals.push(discordMessageId);
    const sql = `UPDATE discord_session_messages SET ${sets.join(', ')} WHERE discord_message_id = ?`;
    this.db.prepare(sql).run(...vals);
    return this.getSessionMessage(discordMessageId);
  }

  reconcileRunningMessages() {
    return this.db.prepare(
      "UPDATE discord_session_messages SET status = 'failed', error = 'Bridge restart during execution' WHERE status IN ('received', 'queued', 'running')"
    ).run();
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }
}

export default new PersistenceStore();
