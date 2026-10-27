import { randomUUID } from 'node:crypto';
import { dbGetOne, dbRun, dbGet } from '../database/db.js';
import { getProject } from './project-service.js';
import { ImplementationVerifier } from './implementation-verifier.js';
import { SecurityAuditor } from './security-auditor.js';
import { GitOperations } from './git-operations.js';
import { ApprovalService } from './approval-service.js';
import { emitWebSocketEvent } from '../realtime/event-bus.js';
import logger from '../logger.js';

export class WorkflowService {
  static getWorkflowReview(id) {
    const row = dbGetOne(
      'SELECT * FROM workflow_reviews WHERE (task_id = ? OR job_id = ? OR id = ?) ORDER BY created_at DESC LIMIT 1',
      [id, id, id]
    );
    if (!row) return null;
    try { row.report = JSON.parse(row.report_json || '{}'); } catch { row.report = {}; }
    return row;
  }

  static async startCompletionWorkflow({
    taskId = null,
    jobId = null,
    projectId,
    prompt = '',
    acceptanceCriteria = [],
    baseline = null,
    taskFiles = []
  }) {
    const reviewId = randomUUID();
    const project = getProject(projectId);
    const workspacePath = project.workspace_path;

    logger.info({ taskId, jobId, projectId }, 'Starting 3-gate completion workflow');

    // Persist initial workflow review state
    dbRun(
      `INSERT INTO workflow_reviews (
        id, task_id, job_id, project_id, reviewed_revision,
        acceptance_status, security_status, git_status, workflow_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', 'PENDING', 'PENDING', 'verifying', datetime('now'), datetime('now'))`,
      [reviewId, taskId, jobId, projectId, GitOperations.getHeadCommit(workspacePath) || 'HEAD']
    );

    if (taskId) {
      dbRun("UPDATE tasks SET workflow_status = 'verifying', execution_status = 'completed', updated_at = datetime('now') WHERE id = ?", [taskId]);
    }
    if (jobId) {
      dbRun("UPDATE jobs SET workflow_status = 'verifying', execution_status = 'completed', updated_at = datetime('now') WHERE id = ?", [jobId]);
    }

    // =========================================================================
    // GATE 1: IMPLEMENTATION VERIFICATION
    // =========================================================================
    emitWebSocketEvent('verification.started', null, { reviewId, taskId, jobId, projectId });
    emitWebSocketEvent('verification.progress', null, { reviewId, taskId, jobId, step: 'running_tests' });

    // Determine actual changed files
    const effectiveTaskFiles = taskFiles && taskFiles.length > 0
      ? taskFiles
      : GitOperations.getTaskOwnedChanges(workspacePath, baseline);

    const verifRes = await ImplementationVerifier.verifyTask({
      projectId,
      workspacePath,
      prompt,
      acceptanceCriteria,
      taskFiles: effectiveTaskFiles
    });

    if (verifRes.status !== 'PASS') {
      emitWebSocketEvent('verification.failed', null, {
        reviewId,
        taskId,
        jobId,
        failedRequirements: verifRes.failedRequirements,
        summary: verifRes.evidenceSummary
      });

      // Update state to blocked
      dbRun(
        `UPDATE workflow_reviews SET acceptance_status = 'FAILED', workflow_status = 'blocked',
         report_json = ?, updated_at = datetime('now') WHERE id = ?`,
        [JSON.stringify({ verification: verifRes }), reviewId]
      );

      if (taskId) dbRun("UPDATE tasks SET workflow_status = 'blocked' WHERE id = ?", [taskId]);
      if (jobId) dbRun("UPDATE jobs SET workflow_status = 'blocked' WHERE id = ?", [jobId]);

      emitWebSocketEvent('workflow.blocked', null, {
        reviewId,
        taskId,
        jobId,
        reason: 'Implementation verification failed'
      });

      return {
        status: 'blocked',
        gate: 'verification',
        verifRes
      };
    }

    emitWebSocketEvent('verification.passed', null, {
      reviewId,
      taskId,
      jobId,
      verifiedRequirements: verifRes.verifiedRequirements
    });

    dbRun(
      `UPDATE workflow_reviews SET acceptance_status = 'PASS', workflow_status = 'auditing', updated_at = datetime('now') WHERE id = ?`,
      [reviewId]
    );

    // =========================================================================
    // GATE 2: INDEPENDENT SECURITY AUDIT
    // =========================================================================
    emitWebSocketEvent('security.audit.started', null, { reviewId, taskId, jobId, projectId });
    emitWebSocketEvent('security.audit.progress', null, { reviewId, taskId, jobId, step: 'scanning_secrets' });

    if (taskId) dbRun("UPDATE tasks SET workflow_status = 'auditing' WHERE id = ?", [taskId]);
    if (jobId) dbRun("UPDATE jobs SET workflow_status = 'auditing' WHERE id = ?", [jobId]);

    const auditRes = await SecurityAuditor.auditWorkspace({
      projectId,
      workspacePath,
      taskId,
      jobId,
      reviewedRevision: GitOperations.getHeadCommit(workspacePath) || 'HEAD',
      taskFiles: effectiveTaskFiles
    });

    if (auditRes.status === 'BLOCKED' || auditRes.status === 'INCOMPLETE') {
      emitWebSocketEvent('security.audit.failed', null, {
        reviewId,
        taskId,
        jobId,
        auditId: auditRes.auditId,
        severitySummary: auditRes.severitySummary,
        status: auditRes.status
      });

      dbRun(
        `UPDATE workflow_reviews SET security_status = ?, workflow_status = 'blocked',
         report_json = ?, updated_at = datetime('now') WHERE id = ?`,
        [auditRes.status, JSON.stringify({ verification: verifRes, security: auditRes }), reviewId]
      );

      if (taskId) dbRun("UPDATE tasks SET workflow_status = 'blocked' WHERE id = ?", [taskId]);
      if (jobId) dbRun("UPDATE jobs SET workflow_status = 'blocked' WHERE id = ?", [jobId]);

      emitWebSocketEvent('workflow.blocked', null, {
        reviewId,
        taskId,
        jobId,
        reason: `Security audit ${auditRes.status}: blocking findings detected`
      });

      return {
        status: 'blocked',
        gate: 'security_audit',
        auditRes
      };
    }

    emitWebSocketEvent('security.audit.passed', null, {
      reviewId,
      taskId,
      jobId,
      auditId: auditRes.auditId,
      severitySummary: auditRes.severitySummary
    });

    dbRun(
      `UPDATE workflow_reviews SET security_status = 'PASS', workflow_status = 'git_review', updated_at = datetime('now') WHERE id = ?`,
      [reviewId]
    );

    // =========================================================================
    // GATE 3: GIT REVIEW & HUMAN APPROVAL
    // =========================================================================
    emitWebSocketEvent('git.review.started', null, { reviewId, taskId, jobId, projectId });

    if (taskId) dbRun("UPDATE tasks SET workflow_status = 'git_review' WHERE id = ?", [taskId]);
    if (jobId) dbRun("UPDATE jobs SET workflow_status = 'git_review' WHERE id = ?", [jobId]);

    // Validate repository identity (including Ballo mismatch check)
    const repoCheck = GitOperations.validateRepositoryIdentity(projectId, workspacePath);
    if (!repoCheck.valid) {
      dbRun(
        `UPDATE workflow_reviews SET git_status = 'BLOCKED', workflow_status = 'blocked',
         report_json = ?, updated_at = datetime('now') WHERE id = ?`,
        [JSON.stringify({ verification: verifRes, security: auditRes, gitError: repoCheck.error }), reviewId]
      );

      if (taskId) dbRun("UPDATE tasks SET workflow_status = 'blocked' WHERE id = ?", [taskId]);
      if (jobId) dbRun("UPDATE jobs SET workflow_status = 'blocked' WHERE id = ?", [jobId]);

      emitWebSocketEvent('workflow.blocked', null, {
        reviewId,
        taskId,
        jobId,
        reason: repoCheck.error
      });

      return {
        status: 'blocked',
        gate: 'git_review',
        error: repoCheck.error
      };
    }

    // Generate git review
    const gitReview = GitOperations.generateGitReview(projectId, workspacePath, baseline, effectiveTaskFiles);

    // If no changes exist: provide clean no-push completion without manufacturing commit
    if (gitReview.noChanges) {
      dbRun(
        `UPDATE workflow_reviews SET git_status = 'NO_CHANGES', workflow_status = 'completed',
         report_json = ?, updated_at = datetime('now') WHERE id = ?`,
        [JSON.stringify({ verification: verifRes, security: auditRes, git: gitReview }), reviewId]
      );

      if (taskId) dbRun("UPDATE tasks SET workflow_status = 'completed', status = 'completed' WHERE id = ?", [taskId]);
      if (jobId) dbRun("UPDATE jobs SET workflow_status = 'completed', status = 'completed' WHERE id = ?", [jobId]);

      emitWebSocketEvent('workflow.completed', null, {
        reviewId,
        taskId,
        jobId,
        projectId,
        noChanges: true,
        message: 'No files were modified. Workflow completed without manufacturing commit.'
      });

      return {
        status: 'completed',
        noChanges: true,
        review: gitReview
      };
    }

    // Create durable Git approval request in database
    const approvalRequest = ApprovalService.createApprovalRequest({
      taskId,
      jobId,
      projectId,
      repositoryIdentity: gitReview.repositoryIdentity,
      targetBranch: gitReview.targetBranch,
      baseRevision: gitReview.baseRevision,
      reviewedRevision: gitReview.reviewedRevision,
      auditId: auditRes.auditId,
      diffSummary: {
        added: gitReview.filesAdded,
        modified: gitReview.filesModified,
        deleted: gitReview.filesDeleted
      },
      taskFiles: gitReview.taskFiles,
      proposedCommitMessage: gitReview.proposedCommitMessage
    });

    dbRun(
      `UPDATE workflow_reviews SET git_status = 'AWAITING_APPROVAL', workflow_status = 'awaiting_approval',
       report_json = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify({ verification: verifRes, security: auditRes, git: gitReview, approvalId: approvalRequest.id }), reviewId]
    );

    if (taskId) dbRun("UPDATE tasks SET workflow_status = 'awaiting_approval' WHERE id = ?", [taskId]);
    if (jobId) dbRun("UPDATE jobs SET workflow_status = 'awaiting_approval' WHERE id = ?", [jobId]);

    // Emit live events to event bus and Discord
    emitWebSocketEvent('git.review.ready', null, {
      reviewId,
      taskId,
      jobId,
      projectId,
      approvalId: approvalRequest.id,
      filesChanged: gitReview.taskFiles.length,
      repository: gitReview.repositoryIdentity,
      targetBranch: gitReview.targetBranch
    });

    emitWebSocketEvent('approval.requested', null, {
      approvalId: approvalRequest.id,
      taskId,
      jobId,
      projectId,
      targetBranch: gitReview.targetBranch,
      filesChangedCount: gitReview.taskFiles.length
    });

    return {
      status: 'awaiting_approval',
      approvalId: approvalRequest.id,
      reviewId,
      gitReview,
      auditRes,
      verifRes
    };
  }

  static recoverPendingWorkflows() {
    const pending = ApprovalService.listPendingApprovals();
    logger.info({ pendingCount: pending.length }, 'Recovered pending Git approvals on startup');
    for (const app of pending) {
      emitWebSocketEvent('approval.requested', null, {
        approvalId: app.id,
        taskId: app.task_id,
        jobId: app.job_id,
        projectId: app.project_id,
        targetBranch: app.target_branch,
        filesChangedCount: app.files_changed?.length || 0,
        recovered: true
      });
    }
  }
}
