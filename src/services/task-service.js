import { randomUUID } from 'node:crypto';
import { dbGetOne, dbRun, dbGet } from '../database/db.js';
import { getProject, validateProjectWorkspace, configureProjectGitRemote } from './project-service.js';
import { getSession } from './session-service.js';
import { GitOperations } from './git-operations.js';
import { WorkflowService } from './workflow-service.js';
import { TaskContextService } from './task-context-service.js';
import { ProjectContextResolver } from './project-context-resolver.js';

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
  const allowLocal = Boolean(project.is_test) || process.env.NODE_ENV === 'test';
  const resolvedContext = ProjectContextResolver.resolveProjectContext({
    project,
    promptText: prompt,
    sessionId,
    allowLocal
  });
  if (!resolvedContext.execution.allowed) {
    throw new Error(resolvedContext.execution.validation_reason);
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
  const isBlocked = task.workflow_status === 'blocked' || task.status === 'blocked' ||
                    task.workflow_status === 'interrupted' || task.status === 'interrupted' ||
                    task.workflow_status === 'failed' || task.status === 'failed';
  return Boolean(isBlocked);
};

export const findRecoverableTask = ({ taskId, sessionId, projectId, projectSlug } = {}) => {
  if (taskId) {
    const task = dbGetOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (task && isTaskRecoverable(task)) return task;
    return null;
  }

  if (sessionId) {
    const tasks = dbGet(
      "SELECT * FROM tasks WHERE session_id = ? AND (workflow_status = 'blocked' OR status = 'blocked' OR workflow_status = 'interrupted' OR status = 'interrupted' OR workflow_status = 'failed' OR status = 'failed') ORDER BY created_at DESC",
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
      "SELECT * FROM tasks WHERE project_id = ? AND (workflow_status = 'blocked' OR status = 'blocked' OR workflow_status = 'interrupted' OR status = 'interrupted' OR workflow_status = 'failed' OR status = 'failed') ORDER BY created_at DESC",
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
    prompt: task.prompt,
    autoRepair: true
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

export const recoverRepositoryMismatchTask = async (taskId, options = {}) => {
  const task = getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const project = getProject(task.project_id);
  const resolvedContext = ProjectContextResolver.resolveProjectContext({
    project,
    promptText: task.prompt,
    sessionId: task.session_id,
    overrides: options
  });

  if (!resolvedContext.execution.allowed) {
    throw new Error(`Cannot recover task: ${resolvedContext.execution.validation_reason}`);
  }

  // Persist resolved repository references
  if (resolvedContext.repository_references?.length > 0) {
    ProjectContextResolver.persistRepositoryReferences(
      taskId,
      project.id,
      resolvedContext.repository_references,
      resolvedContext.execution.validation_result,
      resolvedContext.execution.validation_reason
    );
  }

  // Update snapshot with resolved references and target
  TaskContextService.captureSnapshot(taskId, {
    recoveryAttempts: (TaskContextService.getSnapshot(taskId)?.recovery_attempts || 0) + 1,
    latestExecutionId: task.id,
    expectedTargetRepository: project.repository_url || project.repo_url || null,
    starterRepository: resolvedContext.repository_references.find(r => r.role === 'STARTER')?.url || null
  });

  // Check if task already has a pending approval (Gate 3 human review)
  const pendingApproval = dbGetOne(
    "SELECT * FROM git_approval_requests WHERE task_id = ? AND status = 'pending'",
    [taskId]
  );

  let workflowResult = null;

  if (pendingApproval) {
    // Already verified and awaiting Gate 3 approval: preserve approval, do NOT re-execute or duplicate!
    dbRun(
      "UPDATE tasks SET workflow_status = 'awaiting_approval', status = 'running', error = null, updated_at = datetime('now') WHERE id = ?",
      [taskId]
    );
    workflowResult = {
      action: 'preserved_pending_approval',
      approvalId: pendingApproval.id,
      status: 'awaiting_approval'
    };
  } else if (task.execution_status === 'completed' || task.exit_code === 0) {
    // Execution completed but blocked before/during verification: resume completion workflow without re-running OpenCode
    dbRun(
      "UPDATE tasks SET workflow_status = 'verifying', status = 'running', error = null, updated_at = datetime('now') WHERE id = ?",
      [taskId]
    );
    workflowResult = await WorkflowService.startCompletionWorkflow({
      taskId: task.id,
      projectId: project.id,
      prompt: task.prompt
    });
  } else {
    // If not executed yet or queued
    dbRun(
      "UPDATE tasks SET workflow_status = 'queued', status = 'queued', error = null, updated_at = datetime('now') WHERE id = ?",
      [taskId]
    );
    workflowResult = {
      action: 'requeued',
      status: 'queued'
    };
  }

  const refreshedTask = getTask(taskId);
  TaskContextService.updateSnapshot(taskId, {
    task_status: refreshedTask.status,
    workflow_status: refreshedTask.workflow_status,
    blocker_code: refreshedTask.workflow_status === 'blocked' ? 'WORKFLOW_BLOCKED' : null,
    blocker_details: refreshedTask.error || null
  });

  return {
    taskId,
    recovered: true,
    status: refreshedTask.status,
    workflow_status: refreshedTask.workflow_status,
    project: getProject(project.id),
    task: refreshedTask,
    resolvedContext,
    workflowResult
  };
};
