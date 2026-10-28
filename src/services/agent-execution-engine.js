import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OPENCODE_BIN, NINEROUTER_API_KEY, DEFAULT_MODEL, AUDIT_MODEL_OVERRIDE, INTEGRATION_MODEL_OVERRIDE, MAX_AUDIT_RETRIES, MAX_REPAIR_ATTEMPTS } from '../config.js';
import { dbGetOne, dbRun } from '../database/db.js';
import { WorktreeManager } from './worktree-manager.js';
import { TaskLogger } from './task-logger.js';
import { ParallelScheduler } from './parallel-scheduler.js';
import logger from '../logger.js';
import { emitWebSocketEvent } from '../realtime/event-bus.js';
import { GitOperations } from './git-operations.js';
import { ModelResolver } from './model-resolver.js';
import { ModelRouter } from './model-router.js';
import { ModelRegistry } from './model-registry.js';
import { ModelFailover } from './model-failover.js';

const BUFFER_SIZE = 200;
export const activeExecutions = new Map();

export class AgentExecutionEngine {
  static getActiveExecutions() {
    return Array.from(activeExecutions.entries()).map(([id, v]) => ({
      id,
      role: v.role,
      model: v.model,
      workspacePath: v.workspacePath,
      status: v.status
    }));
  }

  static getActiveExecution(id) {
    return activeExecutions.get(id);
  }

  static async startWorker(subtask) {
    const executionId = randomUUID();
    const project = dbGetOne('SELECT * FROM projects WHERE id = ?', [subtask.project_id]);
    const model = subtask.model || project.default_model || DEFAULT_MODEL;

    let workspacePath = project.workspace_path;
    let branchName = null;
    let isWorktree = false;
    let sourceRevision = WorktreeManager.getHeadRevision(project.workspace_path);

    if (WorktreeManager.isGitRepo(project.workspace_path)) {
      const wt = WorktreeManager.createWorkerWorktree({
        canonicalPath: project.workspace_path,
        projectSlug: project.slug,
        jobId: subtask.job_id,
        subtaskId: subtask.subtask_id
      });
      workspacePath = wt.path;
      branchName = wt.branch;
      isWorktree = wt.isWorktree;
      sourceRevision = WorktreeManager.getHeadRevision(project.workspace_path);
    }

    dbRun(
      `INSERT INTO agent_executions (id, job_id, subtask_id, project_id, role, model, workspace_path, status, attempt, started_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [executionId, subtask.job_id, subtask.id, project.id, 'worker', model, workspacePath, 'running', subtask.attempt + 1]
    );

    activeExecutions.set(executionId, {
      role: 'worker',
      model,
      workspacePath,
      status: 'running',
      subtaskId: subtask.id,
      jobId: subtask.job_id
    });

    emitWebSocketEvent('agent.started', subtask, { executionId, role: 'worker' });

    const plan = ModelResolver.resolveExecutionPlan({
      jobId: subtask.job_id,
      projectId: subtask.project_id,
      role: 'worker',
      prompt: subtask.prompt,
      preferredModel: model || subtask.model
    });
    const targetModel = plan.openCodeModel;
    const args = ['run', '-m', targetModel, '--auto', '--format', 'json'];
    const useStdin = Buffer.byteLength(subtask.prompt || '', 'utf8') > 32768;
    if (!useStdin && subtask.prompt) {
      args.push(subtask.prompt);
    }
    const env = GitOperations.getWorkerEnv({ NINEROUTER_API_KEY });

    const child = spawn(OPENCODE_BIN, args, { cwd: workspacePath, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    if (useStdin && subtask.prompt) {
      child.stdin.end(subtask.prompt, 'utf8');
    } else {
      child.stdin.end();
    }
    const currentExec = activeExecutions.get(executionId);
    if (currentExec) currentExec.process = child;

    dbRun("UPDATE job_subtasks SET process_pid = ?, process_identity = ?, workspace_path = ?, worktree_branch = ?, started_at = datetime('now') WHERE id = ?",
      [child.pid, `pid:${child.pid}:${executionId}`, workspacePath, branchName, subtask.id]);

    const taskLogger = new TaskLogger(`agent-${executionId}`);
    let capturedSession = false;
    const filesChanged = new Set();

    child.stdout.on('data', (chunk) => {
      taskLogger.write(chunk);
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          if (obj.sessionID && !capturedSession) {
            capturedSession = true;
            dbRun('UPDATE job_subtasks SET open_code_session_id = ? WHERE id = ?', [obj.sessionID, subtask.id]);
            dbRun('UPDATE agent_executions SET session_id = ? WHERE id = ?', [obj.sessionID, executionId]);
          }
          if (obj.type === 'tool_use' || obj.type === 'tool_call') {
            const toolName = obj.part?.tool || obj.tool;
            emitWebSocketEvent('agent.progress', subtask, { type: 'tool_use', tool: toolName });
          }
        } catch {}
      }
    });

    child.stderr.on('data', (chunk) => {
      taskLogger.write(chunk);
    });

    const finishWorker = async (exitCode) => {
      taskLogger.end();
      const status = exitCode === 0 ? 'implementation_done' : 'audit_failed';
      const error = exitCode !== 0 ? `OpenCode exited with code ${exitCode}` : null;

      ParallelScheduler.releaseSlot('worker');
      activeExecutions.delete(executionId);

      dbRun(
        `UPDATE agent_executions SET status=?, exit_code=?, error=?, result_json=?, finished_at=datetime('now') WHERE id=?`,
        [status === 'implementation_done' ? 'completed' : 'failed', exitCode, error, JSON.stringify({ workspacePath, sourceRevision, branchName, filesChanged: [...filesChanged] }), executionId]
      );

      ParallelScheduler.updateState(subtask.id, status, status === 'audit_failed' ? 'worker exited non-zero' : 'implementation complete', 'worker');

      emitWebSocketEvent(status === 'implementation_done' ? 'agent.completed' : 'agent.failed', subtask,
        { executionId, exitCode, sourceRevision });

      if (status === 'implementation_done') {
        const subtaskRow = dbGetOne('SELECT * FROM job_subtasks WHERE id = ?', [subtask.id]);
        AgentExecutionEngine.startAuditor(subtaskRow);
      } else {
        const { Supervisor } = await import('./supervisor.js');
        Supervisor.schedule(subtask.job_id);
      }
    };

    child.on('exit', (code) => finishWorker(code));
    child.on('error', (err) => {
      taskLogger.end();
      ParallelScheduler.releaseSlot('worker');
      activeExecutions.delete(executionId);
      ParallelScheduler.updateState(subtask.id, 'blocked', `Spaerror: ${err.message}`, 'worker');
      emitWebSocketEvent('agent.failed', subtask, { executionId, error: err.message });
    });

    return executionId;
  }

  static async startAuditor(subtask, isRepair = false) {
    const auditId = randomUUID();
    const project = dbGetOne('SELECT * FROM projects WHERE id = ?', [subtask.project_id]);
    const auditModel = AUDIT_MODEL_OVERRIDE || process.env.AUDITOR_MODEL || DEFAULT_MODEL;
    const executionId = randomUUID();

    const sourceRevision = subtask.source_revision || WorktreeManager.getHeadRevision(project.workspace_path);

    const auditPrompt = `You are an independent auditor. Inspect the implementation at ${subtask.worktree_path} against these acceptance criteria: ${JSON.stringify(subtask.acceptance_criteria_json)}. 

Produce strict JSON output: {"verdict":"PASS|FAILED","subtaskId":"${subtask.subtask_id}","sourceRevision":"${sourceRevision}","criteria":[...],"tests":[...],"findings":[...],"summary":"..."}

Do NOT fabricate evidence. Execute relevant verification commands.` +
      (isRepair ? `\n\nRepair context findings: ${JSON.stringify(subtask.result_json && JSON.parse(subtask.result_json).findings || [])}` : '');

    dbRun(
      `INSERT INTO agent_executions (id, job_id, subtask_id, project_id, role, model, workspace_path, status, attempt, started_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [executionId, subtask.job_id, subtask.id, project.id, isRepair ? 'repair' : 'auditor', auditModel, subtask.worktree_path || project.workspace_path, 'running', 1]
    );

    if (!isRepair && ParallelScheduler.claimSlot('auditor')) {
      dbRun(`INSERT OR REPLACE INTO agent_audits (id, job_id, subtask_id, worker_execution_id, source_revision, verdict, started_at) VALUES (?,?,?,?,?,?,datetime('now'))`,
        [auditId, subtask.job_id, subtask.id, subtask.worker_execution_id, sourceRevision, 'RUNNING']);
    } else if (isRepair && ParallelScheduler.claimSlot('repair')) {
      dbRun(`INSERT OR REPLACE INTO agent_audits (id, job_id, subtask_id, worker_execution_id, source_revision, verdict, started_at) VALUES (?,?,?,?,?,?,datetime('now'))`,
        [auditId, subtask.job_id, subtask.id, subtask.worker_execution_id, sourceRevision, 'RUNNING']);
    } else {
      return null;
    }

    activeExecutions.set(executionId, {
      role: isRepair ? 'repair' : 'auditor',
      model: auditModel,
      workspacePath: subtask.worktree_path || project.workspace_path,
      status: 'running',
      subtaskId: subtask.id,
      jobId: subtask.job_id,
      auditId
    });

    emitWebSocketEvent('audit.started', subtask, { executionId, role: isRepair ? 'repair' : 'auditor' });

    const plan = ModelResolver.resolveExecutionPlan({
      jobId: subtask.job_id,
      projectId: subtask.project_id,
      role: isRepair ? 'repair' : 'auditor',
      prompt: auditPrompt,
      preferredModel: auditModel
    });
    const targetAuditModel = plan.openCodeModel;
    const args = ['run', '-m', targetAuditModel, '--auto', '--format', 'json'];
    const useStdin = Buffer.byteLength(auditPrompt || '', 'utf8') > 32768;
    if (!useStdin && auditPrompt) {
      args.push(auditPrompt);
    }
    const env = GitOperations.getWorkerEnv({ NINEROUTER_API_KEY });
    const child = spawn(OPENCODE_BIN, args, { cwd: subtask.worktree_path || project.workspace_path, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    if (useStdin && auditPrompt) {
      child.stdin.end(auditPrompt, 'utf8');
    } else {
      child.stdin.end();
    }
    const currentAuditExec = activeExecutions.get(executionId);
    if (currentAuditExec) currentAuditExec.process = child;

    dbRun('UPDATE agent_executions SET process_pid = ?, process_identity = ? WHERE id = ?',
      [child.pid, `pid:${child.pid}:${executionId}`, executionId]);

    const taskLogger = new TaskLogger(`audit-${auditId}`);
    const outputChunks = [];

    child.stdout.on('data', (chunk) => {
      taskLogger.write(chunk);
      outputChunks.push(chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      taskLogger.write(chunk);
      outputChunks.push(chunk.toString());
    });

    const finishAudit = async (exitCode) => {
      taskLogger.end();
      const output = outputChunks.join('');
      let verdict = 'BLOCKED';
      let evidence = {};
      try {
        const parsed = JSON.parse(output.trim().split('\n').pop() || '{}');
        if (parsed && typeof parsed === 'object' && parsed.verdict) {
          verdict = parsed.verdict;
          evidence = parsed;
        }
      } catch {}

      const isRetryExceeded = (subtask.audit_retry_count || 0) >= MAX_AUDIT_RETRIES;
      if (verdict === 'BLOCKED') verdict = 'NOT_TESTED';
      if (isRetryExceeded && verdict === 'FAILED') verdict = 'FAILED';

      ParallelScheduler.releaseSlot(isRepair ? 'repair' : 'auditor');
      activeExecutions.delete(executionId);

      dbRun(
        `UPDATE agent_executions SET status=?, exit_code=?, finished_at=datetime('now'), result_json=? WHERE id=?`,
        [verdict === 'PASS' ? 'completed' : 'failed', exitCode, JSON.stringify(evidence), executionId]
      );

      dbRun(
        `UPDATE agent_audits SET verdict=?, criteria_json=?, tests_json=?, evidence_json=?, findings_json=?, summary=?, finished_at=datetime('now'), auditor_execution_id=? WHERE id=?`,
        [verdict, JSON.stringify(evidence.criteria || []), JSON.stringify(evidence.tests || []), JSON.stringify(evidence), JSON.stringify(evidence.findings || []), evidence.summary || '', executionId, auditId]
      );

      emitWebSocketEvent(verdict === 'PASS' ? 'audit.passed' : 'audit.failed', subtask, { executionId, verdict, auditId });

      if (verdict === 'PASS') {
        ParallelScheduler.updateState(subtask.id, 'integration_pending', 'audit passed', 'auditor');
        const { IntegrationAgent } = await import('./repair-integration-audit.js');
        await IntegrationAgent.startIntegration(subtask, executionId);
      } else {
        ParallelScheduler.updateState(subtask.id, 'repair_pending', `audit ${verdict} with retries`, 'auditor');
        const { RepairAgent } = await import('./repair-integration-audit.js');
        await RepairAgent.attemptRepair(subtask);
      }
    };

    child.on('exit', (code) => finishAudit(code));
    child.on('error', (err) => {
      taskLogger.end();
      ParallelScheduler.releaseSlot(isRepair ? 'repair' : 'auditor');
      activeExecutions.delete(executionId);
      ParallelScheduler.updateState(subtask.id, 'blocked', `Audierror: ${err.message}`, isRepair ? 'repair' : 'auditor');
      emitWebSocketEvent('audit.blocked', subtask, { executionId, error: err.message });
    });

    return executionId;
  }
}
