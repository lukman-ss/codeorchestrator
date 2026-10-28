import { randomUUID } from 'node:crypto';
import { dbGetOne, dbRun, dbGet } from '../database/db.js';
import { getProject } from './project-service.js';
import { GitOperations } from './git-operations.js';
import { GitPublisher } from './git-publisher.js';
import { emitWebSocketEvent } from '../realtime/event-bus.js';
import logger from '../logger.js';

export class ApprovalService {
  static createApprovalRequest({
    taskId = null,
    jobId = null,
    projectId,
    repositoryIdentity,
    targetBranch,
    baseRevision,
    reviewedRevision,
    auditId = null,
    diffSummary = {},
    taskFiles = [],
    proposedCommitMessage = null
  }) {
    const id = randomUUID();
    const effectiveReviewed = reviewedRevision || baseRevision || 'HEAD';
    dbRun(
      `INSERT INTO git_approval_requests (
        id, task_id, job_id, project_id, repository_identity, target_branch,
        base_revision, reviewed_revision, audit_id, status, diff_summary_json,
        files_changed_json, proposed_commit_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))`,
      [
        id,
        taskId,
        jobId,
        projectId,
        repositoryIdentity,
        targetBranch,
        baseRevision,
        effectiveReviewed,
        auditId,
        JSON.stringify(diffSummary || {}),
        JSON.stringify(taskFiles || []),
        proposedCommitMessage
      ]
    );

    return this.getApprovalRequest(id);
  }

  static getApprovalRequest(id) {
    const row = dbGetOne('SELECT * FROM git_approval_requests WHERE id = ?', [id]);
    if (!row) return null;
    try { row.diff_summary = JSON.parse(row.diff_summary_json || '{}'); } catch { row.diff_summary = {}; }
    try { row.files_changed = JSON.parse(row.files_changed_json || '[]'); } catch { row.files_changed = []; }
    return row;
  }

  static getApprovalRequestByTaskOrJob(id) {
    const row = dbGetOne(
      'SELECT * FROM git_approval_requests WHERE (task_id = ? OR job_id = ?) ORDER BY created_at DESC LIMIT 1',
      [id, id]
    );
    if (!row) return null;
    try { row.diff_summary = JSON.parse(row.diff_summary_json || '{}'); } catch { row.diff_summary = {}; }
    try { row.files_changed = JSON.parse(row.files_changed_json || '[]'); } catch { row.files_changed = []; }
    return row;
  }

  static listPendingApprovals(projectId = null) {
    let sql = "SELECT * FROM git_approval_requests WHERE status = 'pending' ORDER BY created_at DESC";
    let params = [];
    if (projectId) {
      sql = "SELECT * FROM git_approval_requests WHERE status = 'pending' AND project_id = ? ORDER BY created_at DESC";
      params = [projectId];
    }
    const rows = dbGet(sql, params);
    return rows.map(r => {
      try { r.diff_summary = JSON.parse(r.diff_summary_json || '{}'); } catch { r.diff_summary = {}; }
      try { r.files_changed = JSON.parse(r.files_changed_json || '[]'); } catch { r.files_changed = []; }
      return r;
    });
  }

  static isUserAuthorizedToApprove(approval, userId, memberRoles = []) {
    if (!userId) return false;
    // Task or Job owner
    if (approval.task_id) {
      const task = dbGetOne('SELECT * FROM tasks WHERE id = ?', [approval.task_id]);
      if (task && task.session_id) {
        const sess = dbGetOne('SELECT user_id FROM sessions WHERE id = ?', [task.session_id]);
        if (sess && sess.user_id === userId) return true;
      }
    }

    // Project owner or creator
    const project = getProject(approval.project_id);
    if (project) {
      if (project.creator_user_id && project.creator_user_id === userId) return true;
    }

    // Check if admin roles or user matches config admin
    const adminUsers = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (adminUsers.includes(userId)) return true;

    // Default permissive for authorized project users if no specific creator
    if (!project?.creator_user_id) return true;

    return false;
  }

  static async processDecision({ approvalRequestId, userId, decision, memberRoles = [], prOptions = {} }) {
    if (!['push', 'create_pr', 'keep_local', 'reject'].includes(decision)) {
      throw new Error(`Invalid decision: ${decision}. Must be 'push', 'create_pr', 'keep_local', or 'reject'.`);
    }

    const approval = this.getApprovalRequest(approvalRequestId);
    if (!approval) {
      throw new Error(`Approval request ${approvalRequestId} not found.`);
    }

    // Idempotency check: if already decided, return existing state
    if (approval.status !== 'pending') {
      return {
        success: false,
        idempotent: true,
        status: approval.status,
        message: `Approval request is already in status '${approval.status}'.`
      };
    }

    // Authorization check
    const authorized = this.isUserAuthorizedToApprove(approval, userId, memberRoles);
    if (!authorized) {
      const err = new Error('Access Denied: You do not have permission to approve or decide this Git operation.');
      err.statusCode = 403;
      throw err;
    }

    const project = getProject(approval.project_id);
    const workspacePath = project.workspace_path;

    // Phase A — Revalidation
    // 1. Confirm repository identity still matches
    const repoCheck = GitOperations.validateRepositoryIdentity(project.id, workspacePath);
    if (!repoCheck.valid) {
      dbRun("UPDATE git_approval_requests SET status = 'invalidated', invalidated_at = datetime('now'), invalidation_reason = ? WHERE id = ?",
        [repoCheck.error, approval.id]);
      emitWebSocketEvent('approval.invalidated', null, { approvalId: approval.id, reason: repoCheck.error });
      throw new Error(`Approval invalidated: ${repoCheck.error}`);
    }

    // 2. Confirm current git tree or revision has not changed since review
    const currentRev = GitOperations.getHeadCommit(workspacePath);
    if (approval.base_revision && currentRev && currentRev !== approval.reviewed_revision && currentRev !== approval.base_revision) {
      const reason = `Code changed after security review (Current: ${currentRev}, Reviewed: ${approval.reviewed_revision})`;
      dbRun("UPDATE git_approval_requests SET status = 'invalidated', invalidated_at = datetime('now'), invalidation_reason = ? WHERE id = ?",
        [reason, approval.id]);
      emitWebSocketEvent('approval.invalidated', null, { approvalId: approval.id, reason });
      throw new Error(`Approval invalidated: ${reason}`);
    }

    // Record decision in database
    const decisionId = randomUUID();
    dbRun(
      `INSERT INTO git_approval_decisions (id, approval_request_id, discord_user_id, decision, decision_timestamp)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [decisionId, approval.id, userId, decision]
    );

    // Handle Reject
    if (decision === 'reject') {
      dbRun("UPDATE git_approval_requests SET status = 'rejected' WHERE id = ?", [approval.id]);
      emitWebSocketEvent('approval.rejected', null, { approvalId: approval.id, userId });
      return { success: true, decision: 'reject', status: 'rejected' };
    }

    // Handle Keep Local
    if (decision === 'keep_local') {
      const opId = randomUUID();
      dbRun(
        `INSERT INTO git_operations (id, task_id, job_id, project_id, approval_request_id, operation, remote, branch, status, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'keep_local', 'local', ?, 'success', datetime('now'), datetime('now'))`,
        [opId, approval.task_id, approval.job_id, project.id, approval.id, approval.target_branch]
      );

      GitOperations.preserveLocalChanges({
        workspacePath,
        taskFiles: approval.files_changed
      });

      dbRun("UPDATE git_approval_requests SET status = 'approved_keep_local' WHERE id = ?", [approval.id]);

      // Complete workflow in reviews and tasks/jobs
      this.markWorkflowCompleted(approval, 'LOCAL_PRESERVED', null);

      emitWebSocketEvent('workflow.completed', null, {
        approvalId: approval.id,
        taskId: approval.task_id,
        jobId: approval.job_id,
        projectId: project.id,
        decision: 'keep_local',
        localPreserved: true
      });

      return {
        success: true,
        decision: 'keep_local',
        localPreserved: true,
        workspacePath
      };
    }

    // Handle Push to GitHub
    if (decision === 'push') {
      emitWebSocketEvent('git.push.started', null, { approvalId: approval.id, taskId: approval.task_id, jobId: approval.job_id });

      const opId = randomUUID();
      const remote = 'origin';
      const branch = approval.target_branch || 'main';

      dbRun(
        `INSERT INTO git_operations (id, task_id, job_id, project_id, approval_request_id, operation, remote, branch, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'commit_and_push', ?, ?, 'running', datetime('now'))`,
        [opId, approval.task_id, approval.job_id, project.id, approval.id, remote, branch]
      );

      // Phase B — Commit task-owned changes
      let commitSha = null;
      if (approval.files_changed && approval.files_changed.length > 0) {
        const commitRes = GitOperations.commitApprovedChanges(
          workspacePath,
          approval.files_changed,
          approval.proposed_commit_message
        );
        commitSha = commitRes.commitSha;
      } else {
        commitSha = GitOperations.getHeadCommit(workspacePath);
      }

      // Phase C — Push
      const pushRes = GitOperations.pushApprovedCommit({
        workspacePath,
        remote,
        branch,
        expectedCommitSha: commitSha
      });

      if (!pushRes.success) {
        dbRun(
          `UPDATE git_operations SET status = 'failed', error_code = ?, error_message = ?, completed_at = datetime('now') WHERE id = ?`,
          [pushRes.diverged ? 'DIVERGED' : 'PUSH_FAILED', pushRes.reason, opId]
        );
        emitWebSocketEvent('git.push.failed', null, {
          approvalId: approval.id,
          taskId: approval.task_id,
          jobId: approval.job_id,
          error: pushRes.reason,
          diverged: pushRes.diverged
        });

        // Do NOT mark task COMPLETED!
        if (approval.task_id) {
          dbRun("UPDATE tasks SET status = 'failed', workflow_status = 'failed' WHERE id = ?", [approval.task_id]);
        }
        if (approval.job_id) {
          dbRun("UPDATE jobs SET workflow_status = 'failed' WHERE id = ?", [approval.job_id]);
        }
        dbRun("UPDATE workflow_reviews SET git_status = 'PUSH_FAILED', workflow_status = 'failed' WHERE (task_id = ? OR job_id = ?)",
          [approval.task_id, approval.job_id]);

        return {
          success: false,
          pushFailed: true,
          reason: pushRes.reason,
          diverged: pushRes.diverged
        };
      }

      // Phase D — Verification & Completion
      dbRun(
        `UPDATE git_operations SET status = 'success', commit_sha = ?, completed_at = datetime('now') WHERE id = ?`,
        [pushRes.commitSha, opId]
      );
      dbRun("UPDATE git_approval_requests SET status = 'approved_push' WHERE id = ?", [approval.id]);

      this.markWorkflowCompleted(approval, 'PUSH_SUCCESS', pushRes.commitSha);

      emitWebSocketEvent('git.push.completed', null, {
        approvalId: approval.id,
        taskId: approval.task_id,
        jobId: approval.job_id,
        commitSha: pushRes.commitSha,
        remote,
        branch
      });

      emitWebSocketEvent('workflow.completed', null, {
        approvalId: approval.id,
        taskId: approval.task_id,
        jobId: approval.job_id,
        projectId: project.id,
        decision: 'push',
        commitSha: pushRes.commitSha
      });

      return {
        success: true,
        decision: 'push',
        commitSha: pushRes.commitSha,
        remote,
        branch
      };
    }

    // Handle Create Pull Request
    if (decision === 'create_pr') {
      emitWebSocketEvent('git.pr.started', null, { approvalId: approval.id, taskId: approval.task_id, jobId: approval.job_id });

      const opId = randomUUID();
      const remote = 'origin';
      const branch = approval.target_branch || 'main';

      dbRun(
        `INSERT INTO git_operations (id, task_id, job_id, project_id, approval_request_id, operation, remote, branch, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'create_pr', ?, ?, 'running', datetime('now'))`,
        [opId, approval.task_id, approval.job_id, project.id, approval.id, remote, branch]
      );

      const prRes = GitPublisher.publishPullRequest({
        approval,
        baseBranch: prOptions.baseBranch || branch,
        featureBranch: prOptions.featureBranch || null,
        title: prOptions.title || approval.proposed_commit_message || null,
        body: prOptions.body || null
      });

      if (!prRes.success) {
        dbRun(
          `UPDATE git_operations SET status = 'failed', error_code = 'PR_FAILED', error_message = ?, completed_at = datetime('now') WHERE id = ?`,
          [prRes.error, opId]
        );
        emitWebSocketEvent('git.pr.failed', null, {
          approvalId: approval.id,
          taskId: approval.task_id,
          jobId: approval.job_id,
          error: prRes.error
        });

        if (approval.task_id) {
          dbRun("UPDATE tasks SET status = 'failed', workflow_status = 'failed' WHERE id = ?", [approval.task_id]);
        }
        if (approval.job_id) {
          dbRun("UPDATE jobs SET workflow_status = 'failed' WHERE id = ?", [approval.job_id]);
        }
        dbRun("UPDATE workflow_reviews SET git_status = 'PR_FAILED', workflow_status = 'failed' WHERE (task_id = ? OR job_id = ?)",
          [approval.task_id, approval.job_id]);

        return {
          success: false,
          prFailed: true,
          reason: prRes.error
        };
      }

      dbRun(
        `UPDATE git_operations SET status = 'success', commit_sha = ?, pr_url = ?, pr_number = ?, completed_at = datetime('now') WHERE id = ?`,
        [prRes.commitSha, prRes.prUrl, prRes.prNumber, opId]
      );
      dbRun("UPDATE git_approval_requests SET status = 'approved_pr', pr_url = ?, pr_number = ? WHERE id = ?", [prRes.prUrl, prRes.prNumber, approval.id]);

      this.markWorkflowCompleted(approval, 'PR_CREATED', prRes.commitSha);

      emitWebSocketEvent('git.pr.created', null, {
        approvalId: approval.id,
        taskId: approval.task_id,
        jobId: approval.job_id,
        commitSha: prRes.commitSha,
        prUrl: prRes.prUrl,
        prNumber: prRes.prNumber,
        branchName: prRes.branchName
      });

      emitWebSocketEvent('workflow.completed', null, {
        approvalId: approval.id,
        taskId: approval.task_id,
        jobId: approval.job_id,
        projectId: project.id,
        decision: 'create_pr',
        commitSha: prRes.commitSha,
        prUrl: prRes.prUrl,
        prNumber: prRes.prNumber
      });

      return {
        success: true,
        decision: 'create_pr',
        commitSha: prRes.commitSha,
        prUrl: prRes.prUrl,
        prNumber: prRes.prNumber,
        branchName: prRes.branchName
      };
    }
  }

  static updateDiscordMessage(approvalId, { messageId, channelId = null }) {
    dbRun(
      "UPDATE git_approval_requests SET discord_message_id = ?, discord_channel_id = COALESCE(?, discord_channel_id) WHERE id = ?",
      [messageId, channelId, approvalId]
    );
    return this.getApprovalRequest(approvalId);
  }

  static getApprovalRequestByDiscordMessage(messageId) {
    const row = dbGetOne(
      'SELECT * FROM git_approval_requests WHERE discord_message_id = ? ORDER BY created_at DESC LIMIT 1',
      [messageId]
    );
    if (!row) return null;
    try { row.diff_summary = JSON.parse(row.diff_summary_json || '{}'); } catch { row.diff_summary = {}; }
    try { row.files_changed = JSON.parse(row.files_changed_json || '[]'); } catch { row.files_changed = []; }
    return row;
  }

  static markWorkflowCompleted(approval, gitStatus, commitSha) {
    if (approval.task_id) {
      dbRun("UPDATE tasks SET workflow_status = 'completed', status = 'completed', updated_at = datetime('now') WHERE id = ?", [approval.task_id]);
      emitWebSocketEvent('task.completed', null, { taskId: approval.task_id, gitStatus, commitSha });
    }
    if (approval.job_id) {
      dbRun("UPDATE jobs SET workflow_status = 'completed', status = 'completed', updated_at = datetime('now') WHERE id = ?", [approval.job_id]);
      emitWebSocketEvent('job.completed', null, { jobId: approval.job_id, gitStatus, commitSha });
    }
    dbRun(
      `UPDATE workflow_reviews SET git_status = ?, workflow_status = 'completed', updated_at = datetime('now')
       WHERE (task_id = ? OR job_id = ?)`,
      [gitStatus, approval.task_id, approval.job_id]
    );
  }
}
