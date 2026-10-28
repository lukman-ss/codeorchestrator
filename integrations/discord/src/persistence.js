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
        terminal_notified INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_discord_executions_status ON discord_executions(status);
      CREATE INDEX IF NOT EXISTS idx_discord_executions_channel ON discord_executions(channel_id);

      CREATE TABLE IF NOT EXISTS discord_processed_events (
        event_key TEXT PRIMARY KEY,
        event_type TEXT,
        execution_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_processed_events_exec ON discord_processed_events(execution_id);

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

      CREATE TABLE IF NOT EXISTS discord_submissions (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_id TEXT,
        submission_type TEXT NOT NULL,
        input_method TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT,
        execution_id TEXT,
        prompt_hash TEXT NOT NULL,
        prompt_length INTEGER NOT NULL,
        artifact_path TEXT,
        status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received', 'confirmed', 'executing', 'completed', 'failed', 'cancelled')),
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_discord_sub_user ON discord_submissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_discord_sub_status ON discord_submissions(status);
      CREATE INDEX IF NOT EXISTS idx_discord_sub_msg ON discord_submissions(message_id);

      CREATE TABLE IF NOT EXISTS discord_multipart_prompts (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        project_id TEXT,
        status TEXT NOT NULL DEFAULT 'collecting' CHECK(status IN ('collecting', 'submitted', 'cancelled')),
        total_chunks INTEGER DEFAULT 0,
        total_bytes INTEGER DEFAULT 0,
        artifact_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_discord_mp_user_scope ON discord_multipart_prompts(guild_id, channel_id, user_id, status);

      CREATE TABLE IF NOT EXISTS discord_multipart_chunks (
        id TEXT PRIMARY KEY,
        multipart_prompt_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        discord_message_id TEXT,
        content TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(multipart_prompt_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_discord_mp_chunk_prompt ON discord_multipart_chunks(multipart_prompt_id);

      CREATE TABLE IF NOT EXISTS discord_approval_messages (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL,
        task_id TEXT,
        job_id TEXT,
        guild_id TEXT,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_approval_msgs_approval ON discord_approval_messages(approval_id);
      CREATE INDEX IF NOT EXISTS idx_approval_msgs_task ON discord_approval_messages(task_id);
      CREATE INDEX IF NOT EXISTS idx_approval_msgs_job ON discord_approval_messages(job_id);
      CREATE INDEX IF NOT EXISTS idx_approval_msgs_message ON discord_approval_messages(message_id);
    `);

    try {
      this.db.exec("ALTER TABLE discord_executions ADD COLUMN terminal_notified INTEGER DEFAULT 0");
    } catch {}
  }

  saveExecution(item) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO discord_executions
      (id, kind, guild_id, channel_id, user_id, message_id, project_id, project_slug, prompt_snippet, status, last_event_sequence, last_event_id, terminal_notified, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
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
      item.lastEventId || null,
      item.terminalNotified ? 1 : 0
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
      } else {
        sets.push('terminal_notified = 0');
      }
    }
    if (updates.terminalNotified !== undefined) {
      sets.push('terminal_notified = ?');
      vals.push(updates.terminalNotified ? 1 : 0);
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

  markTerminalNotified(id) {
    const info = this.db.prepare(
      "UPDATE discord_executions SET terminal_notified = 1, updated_at = datetime('now') WHERE id = ? AND terminal_notified = 0"
    ).run(id);
    return info.changes > 0;
  }

  isEventProcessed(eventKey) {
    const row = this.db.prepare('SELECT 1 FROM discord_processed_events WHERE event_key = ?').get(eventKey);
    return Boolean(row);
  }

  recordProcessedEvent(eventKey, eventType = null, executionId = null) {
    try {
      this.db.prepare(
        'INSERT OR IGNORE INTO discord_processed_events (event_key, event_type, execution_id, created_at) VALUES (?, ?, ?, datetime(\'now\'))'
      ).run(eventKey, eventType, executionId);
    } catch {}
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

  getActiveConversation({ guildId, channelId, threadId = null, discordUserId, projectId = undefined }) {
    let projectClause = '';
    const params = [guildId];

    if (threadId) {
      params.push(threadId, discordUserId);
      if (projectId !== undefined) {
        if (projectId === null) {
          projectClause = ' AND (project_id IS NULL OR project_id = "")';
        } else {
          projectClause = ' AND project_id = ?';
          params.push(projectId);
        }
      }
      return this.db.prepare(`
        SELECT * FROM discord_conversations
        WHERE guild_id = ? AND thread_id = ? AND discord_user_id = ? AND status = 'active'${projectClause}
        ORDER BY last_activity_at DESC, updated_at DESC LIMIT 1
      `).get(...params);
    }

    params.push(channelId, discordUserId);
    if (projectId !== undefined) {
      if (projectId === null) {
        projectClause = ' AND (project_id IS NULL OR project_id = "")';
      } else {
        projectClause = ' AND project_id = ?';
        params.push(projectId);
      }
    }
    return this.db.prepare(`
      SELECT * FROM discord_conversations
      WHERE guild_id = ? AND channel_id = ? AND (thread_id IS NULL OR thread_id = '') AND discord_user_id = ? AND status = 'active'${projectClause}
      ORDER BY last_activity_at DESC, updated_at DESC LIMIT 1
    `).get(...params);
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
    this.db.prepare(
      "UPDATE discord_session_messages SET status = 'failed', error = 'Bridge restart during execution' WHERE status IN ('received', 'queued', 'running')"
    ).run();
    this.db.prepare(
      "UPDATE discord_submissions SET status = 'failed' WHERE status = 'executing'"
    ).run();
  }

  // Submission persistence methods
  saveSubmission(item) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO discord_submissions
      (id, guild_id, channel_id, user_id, message_id, submission_type, input_method, project_id, session_id, execution_id, prompt_hash, prompt_length, artifact_path, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    stmt.run(
      item.id,
      item.guildId,
      item.channelId,
      item.userId,
      item.messageId || null,
      item.submissionType || 'attachment',
      item.inputMethod || 'normal_mention',
      item.projectId || null,
      item.sessionId || null,
      item.executionId || null,
      item.promptHash,
      item.promptLength || 0,
      item.artifactPath || null,
      item.status || 'received',
      item.metadataJson || (item.metadata ? JSON.stringify(item.metadata) : null)
    );
    return this.getSubmission(item.id);
  }

  getSubmission(id) {
    const row = this.db.prepare('SELECT * FROM discord_submissions WHERE id = ?').get(id);
    if (!row) return null;
    let metadata = {};
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch {}
    return { ...row, metadata };
  }

  getSubmissionByMessageId(messageId) {
    const row = this.db.prepare('SELECT * FROM discord_submissions WHERE message_id = ?').get(messageId);
    if (!row) return null;
    let metadata = {};
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch {}
    return { ...row, metadata };
  }

  updateSubmission(id, updates = {}) {
    const sets = [];
    const vals = [];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      vals.push(updates.status);
    }
    if (updates.messageId !== undefined) {
      sets.push('message_id = ?');
      vals.push(updates.messageId);
    }
    if (updates.executionId !== undefined) {
      sets.push('execution_id = ?');
      vals.push(updates.executionId);
    }
    if (updates.sessionId !== undefined) {
      sets.push('session_id = ?');
      vals.push(updates.sessionId);
    }
    if (updates.artifactPath !== undefined) {
      sets.push('artifact_path = ?');
      vals.push(updates.artifactPath);
    }
    if (updates.metadata !== undefined) {
      sets.push('metadata_json = ?');
      vals.push(JSON.stringify(updates.metadata));
    }

    sets.push("updated_at = datetime('now')");
    vals.push(id);

    const sql = `UPDATE discord_submissions SET ${sets.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...vals);
    return this.getSubmission(id);
  }

  claimSubmissionForExecution(id) {
    const info = this.db.prepare(
      `UPDATE discord_submissions
       SET status = 'executing', updated_at = datetime('now')
       WHERE id = ? AND (
         status IN ('received', 'confirmed')
         OR (status = 'executing' AND execution_id IS NULL AND updated_at < datetime('now', '-30 seconds'))
       )`
    ).run(id);
    return info.changes > 0;
  }

  // Multipart Prompt tracking methods
  startMultipartPrompt({ id, guildId, channelId, userId, projectId = null }) {
    // Cancel any existing collecting prompts for this user in this channel
    this.db.prepare(
      "UPDATE discord_multipart_prompts SET status = 'cancelled', updated_at = datetime('now') WHERE guild_id = ? AND channel_id = ? AND user_id = ? AND status = 'collecting'"
    ).run(guildId, channelId, userId);

    const stmt = this.db.prepare(`
      INSERT INTO discord_multipart_prompts
      (id, guild_id, channel_id, user_id, project_id, status, total_chunks, total_bytes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'collecting', 0, 0, datetime('now'), datetime('now'))
    `);
    stmt.run(id, guildId, channelId, userId, projectId);
    return this.getMultipartPrompt(id);
  }

  getActiveMultipartPrompt({ guildId, channelId, userId }) {
    return this.db.prepare(
      "SELECT * FROM discord_multipart_prompts WHERE guild_id = ? AND channel_id = ? AND user_id = ? AND status = 'collecting' ORDER BY created_at DESC LIMIT 1"
    ).get(guildId, channelId, userId);
  }

  getMultipartPrompt(id) {
    return this.db.prepare('SELECT * FROM discord_multipart_prompts WHERE id = ?').get(id);
  }

  addMultipartChunk({ id, multipartPromptId, chunkIndex, discordMessageId = null, content }) {
    const byteLength = Buffer.byteLength(content, 'utf8');
    const stmt = this.db.prepare(`
      INSERT INTO discord_multipart_chunks
      (id, multipart_prompt_id, chunk_index, discord_message_id, content, byte_length, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(id, multipartPromptId, chunkIndex, discordMessageId, content, byteLength);

    this.db.prepare(`
      UPDATE discord_multipart_prompts
      SET total_chunks = total_chunks + 1,
          total_bytes = total_bytes + ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(byteLength, multipartPromptId);

    return this.getMultipartPrompt(multipartPromptId);
  }

  getMultipartChunks(multipartPromptId) {
    return this.db.prepare(
      'SELECT * FROM discord_multipart_chunks WHERE multipart_prompt_id = ? ORDER BY chunk_index ASC'
    ).all(multipartPromptId);
  }

  submitMultipartPrompt(id, artifactPath = null) {
    this.db.prepare(
      "UPDATE discord_multipart_prompts SET status = 'submitted', artifact_path = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(artifactPath, id);
    return this.getMultipartPrompt(id);
  }

  cancelMultipartPrompt(id) {
    this.db.prepare(
      "UPDATE discord_multipart_prompts SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?"
    ).run(id);
    return this.getMultipartPrompt(id);
  }

  // Approval Message tracking methods
  saveApprovalMessage(item) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO discord_approval_messages
      (id, approval_id, task_id, job_id, guild_id, channel_id, message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(
      item.id,
      item.approvalId,
      item.taskId || null,
      item.jobId || null,
      item.guildId || null,
      item.channelId,
      item.messageId
    );
    return this.getApprovalMessage(item.messageId);
  }

  getApprovalMessage(messageId) {
    return this.db.prepare('SELECT * FROM discord_approval_messages WHERE message_id = ?').get(messageId);
  }

  getApprovalMessageByApprovalId(approvalId) {
    return this.db.prepare('SELECT * FROM discord_approval_messages WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1').get(approvalId);
  }

  getApprovalMessageByTaskOrJob(id) {
    return this.db.prepare('SELECT * FROM discord_approval_messages WHERE task_id = ? OR job_id = ? ORDER BY created_at DESC LIMIT 1').get(id, id);
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }
}

export default new PersistenceStore();
