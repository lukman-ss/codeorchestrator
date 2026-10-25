import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { WORKSPACE_ROOT } from '../config.js';
import { dbGet, dbRun, dbGetOne } from '../database/db.js';

export const createProject = ({ name, slug, repoUrl, defaultModel }) => {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid slug');
  const existing = dbGetOne('SELECT id FROM projects WHERE slug = ?', [slug]);
  if (existing) throw new Error('Slug already exists');
  const workspacePath = join(WORKSPACE_ROOT, slug);
  if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true });
  if (repoUrl) {
    // basic validation
    if (!/^https?:\/\/.+/.test(repoUrl)) throw new Error('Invalid repo URL');
    try {
      execSync(`git clone "${repoUrl}" "${workspacePath}"`, { stdio: 'pipe' });
    } catch (err) {
      // cleanup
      if (existsSync(workspacePath)) execSync(`rm -rf "${workspacePath}"`);
      throw err;
    }
  } else {
    mkdirSync(workspacePath, { recursive: true });
  }
  const id = randomUUID();
  dbRun(`INSERT INTO projects (id, name, slug, workspace_path, repo_url, default_model) VALUES (?,?,?,?,?,?)`,
    [id, name, slug, workspacePath, repoUrl || null, defaultModel || '9router/ayce-combo']);
  return dbGetOne('SELECT * FROM projects WHERE id = ?', [id]);
};

export const listProjects = () => dbGet('SELECT * FROM projects ORDER BY created_at DESC');

export const getProject = (id) => {
  const row = dbGetOne('SELECT * FROM projects WHERE id = ?', [id]);
  if (!row) throw new Error('Project not found');
  return row;
};

export const updateProject = (id, patch) => {
  getProject(id); // check exists
  const set = [];
  const vals = [];
  if ('name' in patch) { set.push('name=?'); vals.push(patch.name); }
  if ('defaultModel' in patch) { set.push('default_model=?'); vals.push(patch.defaultModel); }
  if (set.length === 0) return getProject(id);
  vals.push(id);
  dbRun(`UPDATE projects SET ${set.join(', ')}, updated_at=datetime('now') WHERE id=?`, vals);
  return getProject(id);
};

export const importProject = (slug) => {
  const normalized = basename(slug);
  const path = join(WORKSPACE_ROOT, normalized);
  if (!existsSync(path)) throw new Error('Directory not found');
  const existing = dbGetOne('SELECT id FROM projects WHERE workspace_path = ?', [path]);
  if (existing) return getProject(existing.id);
  const id = randomUUID();
  dbRun(`INSERT INTO projects (id, name, slug, workspace_path) VALUES (?,?,?,?)`,
    [id, normalized, normalized, path]);
  return getProject(id);
};
