import { createHash } from 'node:crypto';
import { dbGetOne, dbRun } from '../database/db.js';
import { getProject, detectTechnologyStack } from './project-service.js';
import { GitOperations } from './git-operations.js';

export class TaskContextService {
  static extractStarterRepo(prompt = '') {
    if (!prompt || typeof prompt !== 'string') return null;
    const match = prompt.match(/(?:starter|template)(?:\s*(?:repository|repo)?\s*[:=\s]+|\s*:\s*)(https?:\/\/\S+|git@\S+)/i);
    if (match) {
      return match[1].replace(/[),.]$/, '').trim();
    }
    return null;
  }

  static getPromptHash(prompt = '') {
    if (!prompt) return null;
    return createHash('sha256').update(prompt, 'utf8').digest('hex');
  }

  static captureSnapshot(taskId, overrides = {}) {
    if (!taskId) return null;
    const task = dbGetOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) return null;

    const project = getProject(task.project_id);
    const workspacePath = project.workspace_path;
    const detectedStack = detectTechnologyStack(workspacePath);

    let session = null;
    if (task.session_id) {
      session = dbGetOne('SELECT * FROM sessions WHERE id = ?', [task.session_id]);
    }

    let initialGitRev = overrides.initialGitRevision || null;
    if (!initialGitRev) {
      initialGitRev = GitOperations.getHeadCommit(workspacePath) || null;
    }

    const starterRepo = overrides.starterRepository || this.extractStarterRepo(task.prompt);
    const promptHash = overrides.attachmentHash || this.getPromptHash(task.prompt);
    const expectedTarget = project.repository_url || project.repo_url || overrides.expectedTargetRepository || null;
    const ownerId = overrides.ownerId || session?.user_id || project.creator_user_id || null;

    const existing = dbGetOne('SELECT * FROM task_context_snapshots WHERE task_id = ?', [taskId]);
    const recoveryAttempts = overrides.recoveryAttempts !== undefined
      ? overrides.recoveryAttempts
      : (existing?.recovery_attempts || 0);

    const taskStatus = overrides.taskStatus || task.status || 'queued';
    const workflowStatus = overrides.workflowStatus || task.workflow_status || 'queued';
    const blockerCode = overrides.blockerCode !== undefined
      ? overrides.blockerCode
      : (workflowStatus === 'blocked' ? (existing?.blocker_code || 'WORKFLOW_BLOCKED') : null);
    const blockerDetails = overrides.blockerDetails !== undefined
      ? overrides.blockerDetails
      : (task.error || existing?.blocker_details || null);

    if (existing) {
      dbRun(
        `UPDATE task_context_snapshots SET
          project_id = ?,
          project_slug = ?,
          workspace_path = ?,
          repository_url = ?,
          initial_git_revision = COALESCE(?, initial_git_revision),
          expected_target_repository = ?,
          session_id = ?,
          opencode_session_id = COALESCE(?, opencode_session_id),
          original_prompt_reference = COALESCE(?, original_prompt_reference),
          attachment_hash = COALESCE(?, attachment_hash),
          detected_stack = ?,
          starter_repository = COALESCE(?, starter_repository),
          task_status = ?,
          workflow_status = ?,
          blocker_code = ?,
          blocker_details = ?,
          latest_execution_id = COALESCE(?, latest_execution_id),
          recovery_attempts = ?,
          owner_id = COALESCE(?, owner_id),
          updated_at = datetime('now')
        WHERE task_id = ?`,
        [
          project.id,
          project.slug,
          workspacePath,
          project.repository_url || project.repo_url || null,
          initialGitRev,
          expectedTarget,
          task.session_id || null,
          session?.opencode_session_id || overrides.opencodeSessionId || null,
          overrides.originalPromptReference || existing.original_prompt_reference || null,
          promptHash,
          detectedStack,
          starterRepo,
          taskStatus,
          workflowStatus,
          blockerCode,
          blockerDetails,
          overrides.latestExecutionId || existing.latest_execution_id || null,
          recoveryAttempts,
          ownerId,
          taskId
        ]
      );
    } else {
      dbRun(
        `INSERT INTO task_context_snapshots (
          task_id, project_id, project_slug, workspace_path, repository_url,
          initial_git_revision, expected_target_repository, session_id,
          opencode_session_id, original_prompt_reference, attachment_hash,
          detected_stack, starter_repository, task_status, workflow_status,
          blocker_code, blocker_details, latest_execution_id, recovery_attempts,
          owner_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [
          taskId,
          project.id,
          project.slug,
          workspacePath,
          project.repository_url || project.repo_url || null,
          initialGitRev,
          expectedTarget,
          task.session_id || null,
          session?.opencode_session_id || overrides.opencodeSessionId || null,
          overrides.originalPromptReference || null,
          promptHash,
          detectedStack,
          starterRepo,
          taskStatus,
          workflowStatus,
          blockerCode,
          blockerDetails,
          overrides.latestExecutionId || null,
          recoveryAttempts,
          ownerId
        ]
      );
    }

    return this.getSnapshot(taskId);
  }

  static getSnapshot(taskId) {
    if (!taskId) return null;
    return dbGetOne('SELECT * FROM task_context_snapshots WHERE task_id = ?', [taskId]);
  }

  static updateSnapshot(taskId, patch = {}) {
    if (!taskId) return null;
    const existing = this.getSnapshot(taskId);
    if (!existing) {
      return this.captureSnapshot(taskId, patch);
    }

    const sets = ['updated_at = datetime(\'now\')'];
    const vals = [];

    const allowed = [
      'project_slug', 'workspace_path', 'repository_url', 'initial_git_revision',
      'expected_target_repository', 'session_id', 'opencode_session_id',
      'original_prompt_reference', 'attachment_hash', 'detected_stack',
      'starter_repository', 'task_status', 'workflow_status', 'blocker_code',
      'blocker_details', 'latest_execution_id', 'recovery_attempts', 'owner_id'
    ];

    for (const key of allowed) {
      if (key in patch) {
        sets.push(`${key} = ?`);
        vals.push(patch[key]);
      }
    }

    vals.push(taskId);
    dbRun(`UPDATE task_context_snapshots SET ${sets.join(', ')} WHERE task_id = ?`, vals);
    return this.getSnapshot(taskId);
  }
}
