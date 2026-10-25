import { randomUUID } from 'node:crypto';
import { dbGetOne, dbRun, dbGet } from '../database/db.js';
import { getProject } from './project-service.js';

export const createSession = (projectId, { model, title }) => {
  getProject(projectId);
  const id = randomUUID();
  dbRun(`INSERT INTO sessions (id, project_id, model, title, created_at, updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now'))`,
    [id, projectId, model || null, title || null]);
  return dbGetOne('SELECT * FROM sessions WHERE id = ?', [id]);
};

export const listSessions = (projectId) => {
  getProject(projectId);
  return dbGet('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
};

export const getSession = (id) => {
  const row = dbGetOne('SELECT * FROM sessions WHERE id = ?', [id]);
  if (!row) throw new Error('Session not found');
  return row;
};

export const updateSession = (id, patch) => {
  getSession(id);
  const set = []; const vals = [];
  if ('model' in patch) { set.push('model=?'); vals.push(patch.model); }
  if ('title' in patch) { set.push('title=?'); vals.push(patch.title); }
  if (!set.length) return getSession(id);
  vals.push(id);
  dbRun(`UPDATE sessions SET ${set.join(', ')}, updated_at=datetime('now') WHERE id=?`, vals);
  return getSession(id);
};
