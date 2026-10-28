import { randomUUID } from 'node:crypto';
import { dbGetOne, dbRun, dbGet } from '../database/db.js';
import { getProject, validateProjectWorkspace, configureProjectGitRemote } from './project-service.js';
import { getSession } from './session-service.js';
import { GitOperations } from './git-operations.js';
import { WorkflowService } from './workflow-service.js';
import { TaskContextService } from './task-context-service.js';

export const listTasks = (projectId) => {
  const rows = dbGet('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
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

export const createSession = (projectId, { sessionId: existingSessionId, model, title }) => {
  if (existingSessionId) {
    const sess = getSession(existingSessionId);
    if (sess.project_id && sess.project_id !== projectId) {
      throw new Error('Session does not belong to this project');
    }
    return sess;
  }
  const id = randomUUID();
  dbRun(
    `INSERT INTO sessions (
      id, project_id, session_type, model, title, status, metadata_json, created_at, updated_at
    ) VALUES (?, ?, 'project', ?, ?, 'active', '{}', datetime('now'), datetime('now'))`,
    [id, projectId, model || null, title || null]
  );
  return dbGetOne('SELECT * FROM sessions WHERE id = ?', [id]);
};

export const linkOpenCodeSession = (sessionId, opencodeSessionId) => {
  dbRun("UPDATE sessions SET opencode_session_id = ?, updated_at = datetime('now') WHERE id = ?", [opencodeSessionId, sessionId]);
};

export const createTask = (projectId, { prompt, model, sessionId }) => {
  const project = getProject(projectId);
  const wsCheck = validateProjectWorkspace(project);
  if (!wsCheck.valid) {
    throw new Error(wsCheck.error);
  }
  const session = createSession(projectId, { sessionId, model });
  const id = randomUUID();
  dbRun(
    `INSERT INTO tasks (id, project_id, session_id, prompt, model, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', datetime('now'))`,
    [id, projectId, sessionId || session.id, prompt, model || project.default_model]
  );
  const task = dbGetOne('SELECT * FROM tasks WHERE id = ?', [id]);
  task.session = session;
  try {
    TaskContextService.captureSnapshot(id);
  } catch {}
  return task;
};

export const isTaskRecoverable = (task) => {
  if (!task) return false;
  const isBlocked = task.workflow_status === 'blocked' || task.status === 'blocked' || task.workflow_status === 'interrupted' || task.status === 'interrupted';
  const executionFinished = task.execution_status === 'completed' || task.exit_code === 0;
  return Boolean(isBlocked && executionFinished);
};

export const findRecoverableTask = ({ taskId, sessionId, projectId, projectSlug } = {}) => {
  if (taskId) {
    const task = dbGetOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (task && isTaskRecoverable(task)) return task;
    return null;
  }

  if (sessionId) {
    const tasks = dbGet(
      "SELECT * FROM tasks WHERE session_id = ? AND (workflow_status = 'blocked' OR status = 'blocked' OR workflow_status = 'interrupted' OR status = 'interrupted') AND (execution_status = 'completed' OR exit_code = 0) ORDER BY created_at DESC",
      [sessionId]
    );
    if (tasks.length > 0) return tasks[0];
  }

  let resolvedProjectId = projectId;
  if (!resolvedProjectId && projectSlug) {
    const p = dbGetOne('SELECT id FROM projects WHERE slug = ? OR name = ?', [projectSlug, projectSlug]);
    if (p) resolvedProjectId = p.id;
  }

  if (resolvedProjectId) {
    const tasks = dbGet(
      "SELECT * FROM tasks WHERE project_id = ? AND (workflow_status = 'blocked' OR status = 'blocked' OR workflow_status = 'interrupted' OR status = 'interrupted') AND (execution_status = 'completed' OR exit_code = 0) ORDER BY created_at DESC",
      [resolvedProjectId]
    );
    if (tasks.length === 1) return tasks[0];
    if (tasks.length > 1) {
      const err = new Error(`Multiple recoverable tasks found for project '${resolvedProjectId}'. Explicit task ID required.`);
      err.ambiguous = true;
      err.candidates = tasks.map(t => t.id);
      throw err;
    }
  }

  return null;
};

export const recoverBlockedTask = async (taskId, options = {}) => {
  const task = getTask(taskId);
  if (!isTaskRecoverable(task)) {
    throw new Error(`Task ${taskId} is not in a recoverable state (status: ${task.status}, workflow_status: ${task.workflow_status}, execution_status: ${task.execution_status})`);
  }

  const project = getProject(task.project_id);
  const workspacePath = project.workspace_path;

  if (options.remoteUrl || options.repoUrl) {
    const targetUrl = options.remoteUrl || options.repoUrl;
    configureProjectGitRemote(project.id, {
      repoUrl: targetUrl,
      defaultBranch: options.defaultBranch || project.default_branch || 'main'
    });
  } else if (!GitOperations.isGitRepo(workspacePath)) {
    GitOperations.initLocalGit(workspacePath, project.default_branch || 'main');
    if (project.repository_url || project.repo_url) {
      GitOperations.configureRemote(workspacePath, project.repository_url || project.repo_url);
    }
  }

  TaskContextService.captureSnapshot(taskId, {
    recoveryAttempts: (TaskContextService.getSnapshot(taskId)?.recovery_attempts || 0) + 1,
    latestExecutionId: task.id,
    expectedTargetRepository: options.remoteUrl || options.repoUrl || project.repository_url || project.repo_url || null
  });

  dbRun("UPDATE tasks SET workflow_status = 'verifying', status = 'running', execution_status = 'completed', error = null, updated_at = datetime('now') WHERE id = ?", [taskId]);

  const workflowResult = await WorkflowService.startCompletionWorkflow({
    taskId: task.id,
    projectId: project.id,
    prompt: task.prompt
  });

  const refreshedTask = getTask(taskId);
  TaskContextService.updateSnapshot(taskId, {
    task_status: refreshedTask.status,
    workflow_status: refreshedTask.workflow_status,
    blocker_code: refreshedTask.workflow_status === 'blocked' ? 'WORKFLOW_BLOCKED' : null,
    blocker_details: refreshedTask.error || null
  });

  return {
    taskId,
    status: refreshedTask.status,
    workflow_status: refreshedTask.workflow_status,
    project: getProject(project.id),
    task: refreshedTask,
    workflowResult
  };
};
