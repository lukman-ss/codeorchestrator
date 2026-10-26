import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { WORKSPACE_ROOT } from '../config.js';
import { dbGet, dbRun, dbGetOne } from '../database/db.js';

export const createProject = ({ name, slug, repoUrl, defaultModel, isTest = 0, metadata = {} }) => {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid slug');
  const existing = dbGetOne('SELECT id FROM projects WHERE slug = ?', [slug]);
  if (existing) throw new Error('Slug already exists');
  const workspacePath = join(WORKSPACE_ROOT, slug);
  if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true });
  if (repoUrl) {
    if (!/^https?:\/\/.+/.test(repoUrl)) throw new Error('Invalid repo URL');
    try {
      execSync(`git clone "${repoUrl}" "${workspacePath}"`, { stdio: 'pipe' });
    } catch (err) {
      if (existsSync(workspacePath)) execSync(`rm -rf "${workspacePath}"`);
      throw err;
    }
  } else {
    mkdirSync(workspacePath, { recursive: true });
  }
  const id = randomUUID();
  const metadataJson = JSON.stringify(metadata || {});
  dbRun(
    `INSERT INTO projects (id, name, slug, workspace_path, repo_url, default_model, is_test, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [id, name, slug, workspacePath, repoUrl || null, defaultModel || '9router/ayce-combo', isTest ? 1 : 0, metadataJson]
  );
  return getProject(id);
};

export const listProjects = (options = {}) => {
  const includeTest = typeof options === 'boolean' ? options : !!options.includeTest;
  if (includeTest) {
    return dbGet('SELECT * FROM projects ORDER BY created_at DESC');
  }
  return dbGet('SELECT * FROM projects WHERE is_test = 0 ORDER BY created_at DESC');
};

export const getProject = (id) => {
  const row = dbGetOne('SELECT * FROM projects WHERE id = ?', [id]);
  if (!row) throw new Error('Project not found');
  try {
    row.metadata = JSON.parse(row.metadata_json || '{}');
  } catch {
    row.metadata = {};
  }
  return row;
};

export const updateProject = (id, patch) => {
  getProject(id);
  const set = [];
  const vals = [];
  if ('name' in patch) { set.push('name = ?'); vals.push(patch.name); }
  if ('defaultModel' in patch) { set.push('default_model = ?'); vals.push(patch.defaultModel); }
  if ('isTest' in patch) { set.push('is_test = ?'); vals.push(patch.isTest ? 1 : 0); }
  if ('metadata' in patch) { set.push('metadata_json = ?'); vals.push(JSON.stringify(patch.metadata)); }
  if (set.length === 0) return getProject(id);
  vals.push(id);
  dbRun(`UPDATE projects SET ${set.join(', ')}, updated_at = datetime('now') WHERE id = ?`, vals);
  return getProject(id);
};

export const importProject = (slug, { isTest = 0 } = {}) => {
  const normalized = basename(slug);
  const path = join(WORKSPACE_ROOT, normalized);
  if (!existsSync(path)) throw new Error('Directory not found');
  const existing = dbGetOne('SELECT id FROM projects WHERE workspace_path = ?', [path]);
  if (existing) return getProject(existing.id);
  const id = randomUUID();
  dbRun(
    `INSERT INTO projects (id, name, slug, workspace_path, is_test, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [id, normalized, normalized, path, isTest ? 1 : 0]
  );
  return getProject(id);
};
