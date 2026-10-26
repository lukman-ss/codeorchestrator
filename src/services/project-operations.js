import { randomUUID } from 'node:crypto';
import { dbGetOne, dbRun } from '../database/db.js';
import * as projectService from './project-service.js';

export function getProjectOperation(id) {
  const row = dbGetOne('SELECT * FROM project_operations WHERE id = ?', [id]);
  if (!row) return null;
  let result = null;
  try {
    result = row.result_json ? JSON.parse(row.result_json) : null;
  } catch {
    result = row.result_json;
  }
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    error: row.error,
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function updateProjectOperation(id, { status, result, error }) {
  const sets = ['updated_at = datetime(\'now\')'];
  const vals = [];
  if (status) {
    sets.push('status = ?');
    vals.push(status);
  }
  if (result !== undefined) {
    sets.push('result_json = ?');
    vals.push(result ? JSON.stringify(result) : null);
  }
  if (error !== undefined) {
    sets.push('error = ?');
    vals.push(error);
  }
  vals.push(id);
  dbRun(`UPDATE project_operations SET ${sets.join(', ')} WHERE id = ?`, vals);
  return getProjectOperation(id);
}

export async function startCreateOperation(params) {
  // Validate inputs promptly
  if (!params.name || typeof params.name !== 'string' || !params.name.trim()) {
    throw new Error('Project name is required');
  }
  const slug = (params.slug || projectService.generateSlug(params.name)).trim();
  if (!projectService.validateSlug(slug)) {
    throw new Error('Invalid slug');
  }
  if (params.repoUrl || params.repositoryUrl) {
    const url = (params.repoUrl || params.repositoryUrl).trim();
    const urlCheck = projectService.validateGitHubUrl(url, { allowLocal: Boolean(params.isTest) || process.env.NODE_ENV === 'test' });
    if (!urlCheck.valid) {
      throw new Error(urlCheck.error);
    }
  }

  const id = randomUUID();
  const paramsJson = JSON.stringify(params);

  dbRun(
    `INSERT INTO project_operations (id, type, status, params_json, created_at, updated_at)
     VALUES (?, 'create', 'pending', ?, datetime('now'), datetime('now'))`,
    [id, paramsJson]
  );

  // Execute asynchronously
  setImmediate(async () => {
    try {
      updateProjectOperation(id, { status: 'validating' });
      const hasRepo = Boolean(params.repoUrl || params.repositoryUrl);
      updateProjectOperation(id, { status: hasRepo ? 'cloning' : 'creating' });

      // Create project
      const project = projectService.createProject(params);

      updateProjectOperation(id, { status: 'registering' });
      updateProjectOperation(id, { status: 'completed', result: project });
    } catch (err) {
      updateProjectOperation(id, {
        status: 'failed',
        error: err.message || 'Project creation failed'
      });
    }
  });

  return { operationId: id, status: 'pending' };
}

export function recoverOperations() {
  try {
    dbRun(`
      UPDATE project_operations
      SET status = 'failed', error = 'Operation interrupted by server restart', updated_at = datetime('now')
      WHERE status IN ('pending', 'validating', 'creating', 'cloning', 'registering')
    `);
  } catch {}
}
