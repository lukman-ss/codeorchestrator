import { randomUUID } from 'node:crypto';
import { dbGet, dbGetOne, dbRun } from '../database/db.js';

export class KnowledgeService {
  /**
   * 4-layer persistent technical memory service.
   * Scopes: session, project, task, global.
   * Enforces strict cross-project isolation and provenance tracking.
   */

  static createEntry({
    scope = 'project',
    projectId = null,
    sessionId = null,
    taskId = null,
    ownerId = null,
    title,
    content,
    classification = 'technical',
    sourceReference = null,
    sourceRevision = null,
    accessPolicy = 'project',
    metadata = {}
  }) {
    if (!title || !content) {
      throw new Error('Knowledge entry requires title and content');
    }

    const validScopes = ['session', 'project', 'task', 'global'];
    if (!validScopes.includes(scope)) {
      throw new Error(`Invalid knowledge scope: ${scope}`);
    }

    if (scope === 'project' && !projectId) {
      throw new Error('Project scope requires projectId');
    }
    if (scope === 'session' && !sessionId) {
      throw new Error('Session scope requires sessionId');
    }
    if (scope === 'task' && !taskId) {
      throw new Error('Task scope requires taskId');
    }

    const validClassifications = ['technical', 'architecture', 'convention', 'adr', 'operational', 'summary'];
    if (!validClassifications.includes(classification)) {
      throw new Error(`Invalid classification: ${classification}`);
    }

    const id = randomUUID();
    dbRun(
      `INSERT INTO knowledge_entries (
        id, scope, project_id, session_id, task_id, owner_id,
        title, content, classification, source_reference, source_revision,
        validation_status, access_policy, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?, datetime('now'), datetime('now'))`,
      [
        id,
        scope,
        projectId,
        sessionId,
        taskId,
        ownerId,
        title,
        content,
        classification,
        sourceReference,
        sourceRevision,
        accessPolicy,
        JSON.stringify(metadata || {})
      ]
    );

    return this.getEntry(id);
  }

  static getEntry(id) {
    const row = dbGetOne('SELECT * FROM knowledge_entries WHERE id = ?', [id]);
    if (!row) return null;
    try { row.metadata = JSON.parse(row.metadata_json || '{}'); } catch { row.metadata = {}; }
    return row;
  }

  static listEntries({
    scope = null,
    projectId = null,
    sessionId = null,
    taskId = null,
    classification = null,
    includeGlobal = true,
    limit = 50
  } = {}) {
    let sql = "SELECT * FROM knowledge_entries WHERE validation_status != 'invalid'";
    const params = [];

    if (scope) {
      sql += ' AND scope = ?';
      params.push(scope);
    }

    if (projectId) {
      if (includeGlobal) {
        sql += " AND (project_id = ? OR scope = 'global')";
        params.push(projectId);
      } else {
        sql += ' AND project_id = ?';
        params.push(projectId);
      }
    } else if (!scope && !sessionId && !taskId) {
      // If no specific project/session requested, only return global or explicitly filtered
      sql += " AND scope = 'global'";
    }

    if (sessionId) {
      sql += ' AND session_id = ?';
      params.push(sessionId);
    }

    if (taskId) {
      sql += ' AND task_id = ?';
      params.push(taskId);
    }

    if (classification) {
      sql += ' AND classification = ?';
      params.push(classification);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = dbGet(sql, params);
    return rows.map(r => {
      try { r.metadata = JSON.parse(r.metadata_json || '{}'); } catch { r.metadata = {}; }
      return r;
    });
  }

  static invalidateStale(projectId, currentRevision) {
    if (!projectId || !currentRevision) return 0;
    const res = dbRun(
      "UPDATE knowledge_entries SET validation_status = 'stale', updated_at = datetime('now') WHERE project_id = ? AND source_revision IS NOT NULL AND source_revision != ? AND validation_status = 'valid'",
      [projectId, currentRevision]
    );
    return res?.changes || 0;
  }

  static compileContextPrompt({ projectId = null, sessionId = null, taskId = null, maxChars = 4000 } = {}) {
    const entries = this.listEntries({ projectId, sessionId, taskId, limit: 20 });
    if (!entries || entries.length === 0) return '';

    const lines = ['## Technical Context & Architectural Conventions:'];
    let currentLength = lines[0].length;

    for (const e of entries) {
      const block = `### [${e.classification.toUpperCase()}] ${e.title}\n${e.content}\n`;
      if (currentLength + block.length > maxChars) break;
      lines.push(block);
      currentLength += block.length;
    }

    return lines.join('\n');
  }
}
