import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dbGetOne, dbRun, dbGet } from '../database/db.js';
import { getProject } from './project-service.js';
import { ImplementationVerifier } from './implementation-verifier.js';
import { SecurityAuditor } from './security-auditor.js';
import { GitOperations } from './git-operations.js';
import { ModelResolver } from './model-resolver.js';
import { ModelFailover } from './model-failover.js';
import { ModelRouter } from './model-router.js';
import { ModelRegistry } from './model-registry.js';
import { ApprovalService } from './approval-service.js';
import { emitWebSocketEvent } from '../realtime/event-bus.js';
import { MAX_REPAIR_ATTEMPTS, OPENCODE_BIN, NINEROUTER_API_KEY, DEFAULT_MODEL } from '../config.js';
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
    taskFiles = [],
    autoRepair = false,
    repairAttempt = 0,
    maxRepairAttempts = MAX_REPAIR_ATTEMPTS
  }) {
    const reviewId = randomUUID();
    const project = getProject(projectId);
    const workspacePath = project.workspace_path;

    logger.info({ taskId, jobId, projectId, repairAttempt }, 'Starting 3-gate completion workflow');

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

      // Bounded repair loop: check if autoRepair is active and under limit
      if (autoRepair && taskId && repairAttempt < maxRepairAttempts) {
        logger.info({ taskId, repairAttempt, maxRepairAttempts }, 'Attempting bounded repair for failed verification');
        emitWebSocketEvent('workflow.repair.started', null, {
          taskId,
          reviewId,
          repairAttempt: repairAttempt + 1,
          maxRepairAttempts
        });

        const repairRes = await this.executeTaskRepair({
          taskId,
          projectId,
          workspacePath,
          failedReason: verifRes.evidenceSummary || 'Implementation verification failed',
          attempt: repairAttempt + 1
        });

        if (repairRes.success) {
          emitWebSocketEvent('workflow.repair.completed', null, {
            taskId,
            repairAttempt: repairAttempt + 1
          });
          return this.startCompletionWorkflow({
            taskId,
            jobId,
            projectId,
            prompt,
            acceptanceCriteria,
            baseline,
            taskFiles,
            autoRepair: true,
            repairAttempt: repairAttempt + 1,
            maxRepairAttempts
          });
        }
      }

      const blockReason = verifRes.evidenceSummary
        ? `Verification failed: ${verifRes.evidenceSummary}${repairAttempt > 0 ? ` (repair attempts: ${repairAttempt}/${maxRepairAttempts})` : ''}`
        : 'Implementation verification failed';

      // Update state to blocked
      dbRun(
        `UPDATE workflow_reviews SET acceptance_status = 'FAILED', workflow_status = 'blocked',
         report_json = ?, updated_at = datetime('now') WHERE id = ?`,
        [JSON.stringify({ verification: verifRes, repairAttempts: repairAttempt }), reviewId]
      );

      if (taskId) dbRun("UPDATE tasks SET status = 'blocked', workflow_status = 'blocked', error = ? WHERE id = ?", [blockReason, taskId]);
      if (jobId) dbRun("UPDATE jobs SET workflow_status = 'blocked' WHERE id = ?", [jobId]);

      emitWebSocketEvent('workflow.blocked', null, {
        reviewId,
        taskId,
        jobId,
        reason: blockReason
      });

      return {
        status: 'blocked',
        gate: 'verification',
        verifRes,
        repairAttempts: repairAttempt
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

      const secReason = auditRes.reason || `Security audit ${auditRes.status}: blocking findings detected`;
      dbRun(
        `UPDATE workflow_reviews SET security_status = ?, workflow_status = 'blocked',
         report_json = ?, updated_at = datetime('now') WHERE id = ?`,
        [auditRes.status, JSON.stringify({ verification: verifRes, security: auditRes }), reviewId]
      );

      if (taskId) dbRun("UPDATE tasks SET status = 'blocked', workflow_status = 'blocked', error = ? WHERE id = ?", [secReason, taskId]);
      if (jobId) dbRun("UPDATE jobs SET workflow_status = 'blocked' WHERE id = ?", [jobId]);

      emitWebSocketEvent('workflow.blocked', null, {
        reviewId,
        taskId,
        jobId,
        reason: secReason
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
      const repoReason = repoCheck.error || 'Git repository mismatch';
      dbRun(
        `UPDATE workflow_reviews SET git_status = 'PUSH_FAILED', workflow_status = 'blocked',
         report_json = ?, updated_at = datetime('now') WHERE id = ?`,
        [JSON.stringify({ verification: verifRes, security: auditRes, gitError: repoReason }), reviewId]
      );

      if (taskId) dbRun("UPDATE tasks SET status = 'blocked', workflow_status = 'blocked', error = ? WHERE id = ?", [repoReason, taskId]);
      if (jobId) dbRun("UPDATE jobs SET workflow_status = 'blocked' WHERE id = ?", [jobId]);

      emitWebSocketEvent('workflow.blocked', null, {
        reviewId,
        taskId,
        jobId,
        reason: repoReason
      });

      return {
        status: 'blocked',
        gate: 'git_review',
        error: repoCheck.error
      };
    }

    // Generate git review
    const gitReview = GitOperations.generateGitReview(projectId, workspacePath, baseline, effectiveTaskFiles);

    // Create durable Git approval request in database (including zero-change tasks)
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
        added: gitReview.filesAdded || 0,
        modified: gitReview.filesModified || 0,
        deleted: gitReview.filesDeleted || 0
      },
      taskFiles: gitReview.taskFiles || [],
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
      noChanges: gitReview.noChanges,
      repository: gitReview.repositoryIdentity,
      targetBranch: gitReview.targetBranch
    });

    emitWebSocketEvent('approval.requested', null, {
      approvalId: approvalRequest.id,
      taskId,
      jobId,
      projectId,
      noChanges: gitReview.noChanges,
      targetBranch: gitReview.targetBranch,
      filesChangedCount: gitReview.taskFiles.length
    });

    return {
      status: 'awaiting_approval',
      noChanges: gitReview.noChanges,
      approvalId: approvalRequest.id,
      approvalRequest,
      reviewId,
      review: gitReview,
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

  static async executeTaskRepair({ taskId, projectId, workspacePath, failedReason, attempt }) {
    return new Promise((resolve) => {
      const repairPrompt = `Fix implementation errors to satisfy verification criteria.\nFailure details:\n${failedReason}\nWorkspace: ${workspacePath}\nFix all failing tests and formatting issues.`;
      const env = GitOperations.getWorkerEnv({ NINEROUTER_API_KEY });
      const plan = ModelResolver.resolveExecutionPlan({
        taskId,
        projectId,
        role: 'repair',
        prompt: repairPrompt,
        preferredEffort: attempt > 1 ? 'high' : 'medium'
      });
      const repairModel = plan.openCodeModel;
      const args = ['run', '-m', repairModel, '--auto', '--format', 'json'];

      if (attempt > 1) {
        ModelFailover.recordFailoverEvent({
          taskId,
          projectId,
          previousModel: DEFAULT_MODEL,
          previousEffort: 'medium',
          failureCategory: 'reasoning',
          recoveryStrategy: plan.effort === 'high' ? 'increase_effort' : 'switch_model',
          nextModel: plan.model,
          nextEffort: plan.effort,
          handoffArtifact: { failedReason, attempt, workspacePath }
        });
      }

      try {
        const child = spawn(OPENCODE_BIN, [...args, repairPrompt], {
          cwd: workspacePath,
          env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({ success: false, error: 'Repair timeout' });
        }, 120000);

        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ success: code === 0, code });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ success: false, error: err.message });
        });
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  }
}
