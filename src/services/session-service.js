import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { dbGetOne, dbRun, dbGet } from '../database/db.js';
import { getProject, validateProjectWorkspace } from './project-service.js';
import { emitWebSocketEvent } from '../realtime/event-bus.js';
import {
  OPENCODE_BIN,
  NINEROUTER_API_KEY,
  DEFAULT_MODEL,
  SESSION_RUNTIME_ROOT,
  TASK_TIMEOUT_SECONDS
} from '../config.js';
import logger from '../logger.js';

// Mutex / Queue per session to prevent concurrent writes from corrupting OpenCode session context
const sessionLocks = new Map();

export const recoverSessions = () => {
  dbRun("UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE status = 'active'");
};

async function withSessionLock(sessionId, fn) {
  const previous = sessionLocks.get(sessionId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  sessionLocks.set(sessionId, current);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (sessionLocks.get(sessionId) === current) {
      sessionLocks.delete(sessionId);
    }
  }
}

export const createSession = (arg1, arg2 = {}) => {
  let projectId = null;
  let model = null;
  let title = null;
  let type = null;
  let userId = null;
  let metadata = {};

  if (typeof arg1 === 'string') {
    projectId = arg1;
    model = arg2.model || null;
    title = arg2.title || null;
    type = arg2.type || 'project';
    userId = arg2.userId || null;
    metadata = arg2.metadata || {};
  } else if (typeof arg1 === 'object' && arg1 !== null) {
    projectId = arg1.projectId || arg1.project_id || null;
    model = arg1.model || null;
    title = arg1.title || null;
    type = arg1.type || (projectId ? 'project' : 'standalone');
    userId = arg1.userId || arg1.user_id || null;
    metadata = arg1.metadata || {};
  }

  const id = randomUUID();
  let runtimePath = null;

  if (projectId || type === 'project') {
    if (!projectId) throw new Error('Project ID is required for project sessions');
    const project = getProject(projectId); // Validates project existence
    const wsCheck = validateProjectWorkspace(project);
    if (!wsCheck.valid) {
      throw new Error(wsCheck.error);
    }
    type = 'project';
  } else {
    type = 'standalone';
    projectId = null;
    runtimePath = join(SESSION_RUNTIME_ROOT, id);
    mkdirSync(runtimePath, { recursive: true });
  }

  const metadataJson = JSON.stringify(metadata || {});

  dbRun(
    `INSERT INTO sessions (
      id, project_id, session_type, model, title, status, user_id, runtime_path, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, datetime('now'), datetime('now'))`,
    [id, projectId, type, model || null, title || null, userId || null, runtimePath, metadataJson]
  );

  return getSession(id);
};

export const getSession = (id) => {
  const row = dbGetOne('SELECT * FROM sessions WHERE id = ?', [id]);
  if (!row) throw new Error('Session not found');
  try {
    row.metadata = JSON.parse(row.metadata_json || '{}');
  } catch {
    row.metadata = {};
  }
  return row;
};

export const listSessions = (options = {}) => {
  let projectId = undefined;
  let type = undefined;
  let userId = undefined;
  let limit = 50;
  let offset = 0;

  if (typeof options === 'string') {
    projectId = options;
  } else if (typeof options === 'object' && options !== null) {
    projectId = options.projectId !== undefined ? options.projectId : options.project_id;
    type = options.type;
    userId = options.userId !== undefined ? options.userId : options.user_id;
    if (options.limit !== undefined) limit = Number(options.limit) || 50;
    if (options.offset !== undefined) offset = Number(options.offset) || 0;
  }

  const clauses = [];
  const params = [];

  if (projectId !== undefined) {
    if (projectId === null || projectId === '') {
      clauses.push('project_id IS NULL');
    } else {
      clauses.push('project_id = ?');
      params.push(projectId);
    }
  }

  if (type) {
    clauses.push('session_type = ?');
    params.push(type);
  }

  if (userId) {
    clauses.push('user_id = ?');
    params.push(userId);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT * FROM sessions ${where} ORDER BY updated_at DESC, created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = dbGet(sql, params);
  return rows.map(r => {
    try {
      r.metadata = JSON.parse(r.metadata_json || '{}');
    } catch {
      r.metadata = {};
    }
    return r;
  });
};

export const updateSession = (id, patch = {}) => {
  const session = getSession(id);

  // Security & Safety boundary: prohibit silent cross-workspace rebinding
  if (('projectId' in patch && patch.projectId !== session.project_id) ||
      ('project_id' in patch && patch.project_id !== session.project_id) ||
      ('type' in patch && patch.type !== session.session_type) ||
      ('session_type' in patch && patch.session_type !== session.session_type)) {
    throw new Error('Direct session linking/unlinking across workspace boundaries is unsupported. Create a new session to preserve workspace safety.');
  }

  const set = [];
  const vals = [];

  if ('model' in patch) { set.push('model = ?'); vals.push(patch.model); }
  if ('title' in patch) { set.push('title = ?'); vals.push(patch.title); }
  if ('status' in patch) {
    const validStatuses = ['created', 'active', 'idle', 'interrupted', 'closed'];
    if (!validStatuses.includes(patch.status)) {
      throw new Error(`Invalid session status: ${patch.status}`);
    }
    set.push('status = ?');
    vals.push(patch.status);
  }
  if ('userId' in patch || 'user_id' in patch) {
    set.push('user_id = ?');
    vals.push(patch.userId || patch.user_id || null);
  }
  if ('opencode_session_id' in patch) {
    set.push('opencode_session_id = ?');
    vals.push(patch.opencode_session_id);
  }
  if ('metadata' in patch) {
    const merged = { ...session.metadata, ...(patch.metadata || {}) };
    set.push('metadata_json = ?');
    vals.push(JSON.stringify(merged));
  }

  if (!set.length) return getSession(id);

  vals.push(id);
  dbRun(`UPDATE sessions SET ${set.join(', ')}, updated_at = datetime('now') WHERE id = ?`, vals);
  return getSession(id);
};

export const deleteSession = (id) => {
  const session = getSession(id);
  dbRun('DELETE FROM sessions WHERE id = ?', [id]);
  return { success: true, id };
};

export const listSessionMessages = (sessionId) => {
  getSession(sessionId);
  return dbGet('SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId]);
};

export const executeSessionMessage = async (sessionId, { prompt, model, userId } = {}) => {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Prompt is required');
  }

  return withSessionLock(sessionId, async () => {
    const session = getSession(sessionId);

    if (session.status === 'closed') {
      throw new Error('Session is closed');
    }

    if (session.user_id && userId && session.user_id !== userId) {
      throw new Error('Unauthorized access to private session');
    }

    // Resolve execution working directory
    let workingDir;
    if (session.session_type === 'standalone') {
      workingDir = session.runtime_path || join(SESSION_RUNTIME_ROOT, session.id);
      mkdirSync(workingDir, { recursive: true });
    } else {
      const project = getProject(session.project_id);
      const wsCheck = validateProjectWorkspace(project);
      if (!wsCheck.valid) {
        throw new Error(wsCheck.error);
      }
      workingDir = project.workspace_path;
      if (!existsSync(workingDir)) mkdirSync(workingDir, { recursive: true });
    }

    // Persist incoming user message
    const userMessageId = randomUUID();
    dbRun(
      `INSERT INTO session_messages (id, session_id, role, content, opencode_session_id, created_at)
       VALUES (?, ?, 'user', ?, ?, datetime('now'))`,
      [userMessageId, session.id, prompt, session.opencode_session_id || null]
    );

    // Update session state to active
    dbRun("UPDATE sessions SET status = 'active', updated_at = datetime('now') WHERE id = ?", [session.id]);

    const targetModel = model || session.model || DEFAULT_MODEL;
    const args = ['run', '-m', targetModel, '--auto', '--format', 'json'];

    // Session continuation via real OpenCode session ID
    if (session.opencode_session_id) {
      args.push('-s', session.opencode_session_id);
    }

    // Pass via stdin when prompt length exceeds CLI argument threshold to prevent E2BIG
    const useStdin = Buffer.byteLength(prompt, 'utf8') > 32768;
    if (!useStdin) {
      args.push(prompt);
    }

    logger.info({ sessionId: session.id, model: targetModel, workingDir, hasSessionId: !!session.opencode_session_id }, 'Spawning OpenCode session message execution');
    emitWebSocketEvent('session.started', null, { sessionId: session.id, projectId: session.project_id });

    const env = {
      ...process.env,
      NINEROUTER_API_KEY: NINEROUTER_API_KEY
    };

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(OPENCODE_BIN, args, {
          cwd: workingDir,
          env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        if (useStdin) {
          child.stdin.end(prompt, 'utf8');
        } else {
          child.stdin.end();
        }
      } catch (err) {
        dbRun("UPDATE sessions SET status = 'interrupted', updated_at = datetime('now') WHERE id = ?", [session.id]);
        return reject(err);
      }

      let stdoutText = '';
      let stdoutBuffer = '';
      let stderrText = '';
      let capturedSessionId = session.opencode_session_id || null;
      let assistantResponse = '';

      const timeoutMs = (TASK_TIMEOUT_SECONDS || 3600) * 1000;
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
      }, timeoutMs);

      const processJsonLine = (line) => {
        if (!line || !line.trim()) return;
        try {
          const ev = JSON.parse(line.trim());
          if (ev.sessionID && !capturedSessionId) {
            capturedSessionId = ev.sessionID;
            dbRun("UPDATE sessions SET opencode_session_id = ?, updated_at = datetime('now') WHERE id = ?", [capturedSessionId, session.id]);
          }
          if (ev.type === 'text') {
            const partText = ev.part?.text || ev.text || '';
            assistantResponse += partText;
            emitWebSocketEvent('session.progress', null, { sessionId: session.id, text: partText });
          }
        } catch {}
      };

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdoutText += text;
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop(); // Retain incomplete trailing slice
        for (const line of lines) {
          processJsonLine(line);
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrText += chunk.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        dbRun("UPDATE sessions SET status = 'interrupted', updated_at = datetime('now') WHERE id = ?", [session.id]);
        emitWebSocketEvent('session.failed', null, { sessionId: session.id, error: err.message });
        reject(err);
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        if (stdoutBuffer) {
          processJsonLine(stdoutBuffer);
          stdoutBuffer = '';
        }
        if (code === 0) {
          const finalResponse = assistantResponse.trim() || stdoutText.trim();
          const assistantMsgId = randomUUID();
          dbRun(
            `INSERT INTO session_messages (id, session_id, role, content, opencode_session_id, created_at)
             VALUES (?, ?, 'assistant', ?, ?, datetime('now'))`,
            [assistantMsgId, session.id, finalResponse, capturedSessionId]
          );
          dbRun(
            "UPDATE sessions SET status = 'idle', opencode_session_id = COALESCE(?, opencode_session_id), updated_at = datetime('now') WHERE id = ?",
            [capturedSessionId, session.id]
          );
          emitWebSocketEvent('session.completed', null, { sessionId: session.id, response: finalResponse, status: 'completed' });
          resolve({
            sessionId: session.id,
            opencodeSessionId: capturedSessionId,
            response: finalResponse,
            status: 'idle'
          });
        } else {
          dbRun("UPDATE sessions SET status = 'interrupted', updated_at = datetime('now') WHERE id = ?", [session.id]);
          const errMsg = `OpenCode execution failed with exit code ${code}: ${stderrText || stdoutText}`;
          emitWebSocketEvent('session.failed', null, { sessionId: session.id, error: errMsg });
          reject(new Error(errMsg));
        }
      });
    });
  });
};
