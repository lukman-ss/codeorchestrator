import { randomUUID } from 'node:crypto';
import { dbGetOne, dbRun, dbGet } from '../database/db.js';
import { getProject } from './project-service.js';
import { getSession } from './session-service.js';

export const listTasks = (projectId) => {
  const rows = dbGet('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
  // validate project exists to throw 404
  getProject(projectId);
  return rows;
};

export const listAllTasks = () => dbGet('SELECT * FROM tasks ORDER BY created_at DESC');

export const getTask = (id) => {
  const row = dbGetOne('SELECT * FROM tasks WHERE id = ?', [id]);
  if (!row) throw new Error('Task not found');
  return row;
};

export const getTaskEvents = (id, afterSequence = 0) => {
  getTask(id);
  return dbGet('SELECT * FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence', [id, afterSequence]);
};

export const createSession = (projectId, { sessionId: existingSessionId, model }) => {
  if (existingSessionId) {
    // Reuse provided session, validate ownership
    const sess = getSession(existingSessionId);
    if (sess.project_id !== projectId) throw new Error('Session does not belong to this project');
    return sess;
  }
  // Create placeholder; actual opencode_session_id filled later
  const id = randomUUID();
  dbRun(`INSERT INTO sessions (id, project_id, model, title, created_at, updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now'))`,
    [id, projectId, model || null, null]);
  return dbGetOne('SELECT * FROM sessions WHERE id = ?', [id]);
};

export const linkOpenCodeSession = (sessionId, opencodeSessionId) => {
  dbRun(`UPDATE sessions SET opencode_session_id=?, updated_at=datetime('now') WHERE id=?`, [opencodeSessionId, sessionId]);
};

export const createTask = (projectId, { prompt, model, sessionId }) => {
  const project = getProject(projectId);
  const session = createSession(projectId, { sessionId, model });
  const id = randomUUID();
  dbRun(`INSERT INTO tasks (id, project_id, session_id, prompt, model, status, created_at) VALUES (?,?,?,?,?,'queued',datetime('now'))`,
    [id, projectId, sessionId || session.id, prompt, model || project.default_model]);
  const task = dbGetOne('SELECT * FROM tasks WHERE id = ?', [id]);
  task.session = session;
  return task;
};
