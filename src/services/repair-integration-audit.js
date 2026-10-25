import { randomUUID } from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { dbGetOne, dbRun } from '../database/db.js';
import { ParallelScheduler } from './parallel-scheduler.js';
import { AgentExecutionEngine } from './agent-execution-engine.js';
import { emitWebSocketEvent } from '../realtime/event-bus.js';
import { TaskLogger } from './task-logger.js';
import { MAX_REPAIR_ATTEMPTS } from '../config.js';
import { OPENCODE_BIN, NINEROUTER_API_KEY, DEFAULT_MODEL, INTEGRATION_MODEL_OVERRIDE } from '../config.js';
import logger from '../logger.js';
import { Supervisor } from './supervisor.js';

export class RepairAgent {
  static async attemptRepair(subtask) {
    if ((subtask.audit_retry_count || 0) >= MAX_REPAIR_ATTEMPTS) {
      ParallelScheduler.updateState(subtask.id, 'blocked', 'repair attempts exhausted', 'supervisor');
      return;
    }

    dbRun('UPDATE job_subtasks SET audit_retry_count = COALESCE(audit_retry_count, 0) + 1, status = ? WHERE id = ?', ['repair_pending', subtask.id]);

    const audit = dbGetOne('SELECT * FROM agent_audits WHERE subtask_id = ? ORDER BY created_at DESC LIMIT 1', [subtask.id]);
    const findings = audit ? (JSON.parse(audit.findings_json || '[]')) : [];

    const workerExec = dbGetOne('SELECT id FROM agent_executions WHERE subtask_id = ? ORDER BY started_at DESC LIMIT 1', [subtask.id]);

    const repairPrompt = `You are a repair engineer. Fix the following failed acceptance criteria: ${JSON.stringify(subtask.acceptance_criteria_json)}

Auditor findings:
${JSON.stringify(findings)}

The implementation is in: ${subtask.worktree_path || 'project workspace'}

Produce complete working code that satisfies the original requirements.

Use OpenCode JSON format output.`;

    const executionId = randomUUID();
    const project = dbGetOne('SELECT * FROM projects WHERE id = ?', [subtask.project_id]);
    const model = subtask.model || project.default_model || DEFAULT_MODEL;

    let workspacePath = subtask.worktree_path || project.workspace_path;

    if (subtask.worktree_path && project.workspace_path) {
      workspacePath = subtask.worktree_path;
    }

    dbRun(
      `INSERT INTO agent_executions (id, job_id, subtask_id, project_id, role, model, workspace_path, status, attempt, started_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [executionId, subtask.job_id, subtask.id, project.id, 'repair', model, workspacePath, 'running', (workerExec ? workerExec.attempt || 1 : 1) + 1]
    );

    activeExecutions.set(executionId, {
      role: 'repair',
      model,
      workspacePath,
      status: 'running',
      subtaskId: subtask.id,
      jobId: subtask.job_id
    });

    emitWebSocketEvent('repair.started', subtask, { executionId, role: 'repair' });

    const args = ['-m', model, '--auto', '--pure', 'run', '--format', 'json', repairPrompt];
    const env = { ...process.env, NINEROUTER_API_KEY };

    const child = spawn(OPENCODE_BIN, args, { cwd: workspacePath, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

    dbRun(
      `UPDATE agent_executions SET process_pid = ?, process_identity = ?, started_at = datetime('now') WHERE id = ?`,
      [child.pid, `pid:${child.pid}:${executionId}`, executionId]
    );

    const taskLogger = new TaskLogger(`repair-${executionId}`);
    const outputChunks = [];

    child.stdout.on('data', (chunk) => {
      taskLogger.write(chunk);
      outputChunks.push(chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      taskLogger.write(chunk);
      outputChunks.push(chunk.toString());
    });

    const finishRepair = async (exitCode) => {
      taskLogger.end();
      const output = outputChunks.join('');
      let verdict = 'BLOCKED';
      try {
        const parsed = JSON.parse(output.trim().split('\n').pop() || '{}');
        if (parsed && typeof parsed === 'object') verdict = parsed.verdict || 'PASS';
      } catch {}

      ParallelScheduler.releaseSlot('repair');
      activeExecutions.delete(executionId);

      dbRun(
        `UPDATE agent_executions SET status=?, exit_code=?, finished_at=datetime('now'), result_json=? WHERE id=?`,
        [exitCode === 0 ? 'completed' : 'failed', exitCode, JSON.stringify({ workspacePath, output }), executionId]
      );

      const nextStatus = exitCode === 0 ? 'implementation_done' : 'audit_failed';
      ParallelScheduler.updateState(subtask.id, nextStatus, `repair exit code ${exitCode}`, 'repair');

      if (exitCode === 0) {
        const { startAuditor } = await import('./agent-execution-engine.js');
        const subtaskRow = dbGetOne('SELECT * FROM job_subtasks WHERE id = ?', [subtask.id]);
        subtaskRow.source_revision = subtaskRow.source_revision || 'HEAD';
        await startAuditor(subtaskRow, true);
      } else {
        dbRun('UPDATE agent_executions SET status=? WHERE id=?', ['failed', executionId]);
        ParallelScheduler.schedule(subtask.job_id);
      }
    };

    child.on('exit', finishRepair);
    child.on('error', (err) => {
      taskLogger.end();
      ParallelScheduler.releaseSlot('repair');
      activeExecutions.delete(executionId);
      ParallelScheduler.updateState(subtask.id, 'blocked', `Repair error: ${err.message}`, 'repair');
    });

    return executionId;
  }
}

export class IntegrationAgent {
  static async startIntegration(subtask, auditExecutionId) {
    const executionId = randomUUID();
    const project = dbGetOne('SELECT * FROM projects WHERE id = ?', [subtask.project_id]);
    const integrationModel = INTEGRATION_MODEL_OVERRIDE || process.env.INTEGRATION_MODEL || DEFAULT_MODEL;

    const existingLock = dbGetOne('SELECT * FROM integration_locks WHERE project_id = ?', [project.id]);
    if (existingLock) {
      logger.warn({ projectId: project.id }, 'Integration lock already held, skipping integration');
      ParallelScheduler.releaseSlot('integration');
      return;
    }

    const lockId = randomUUID();
    const now = new Date().toISOString();
    dbRun(`INSERT INTO integration_locks (id, project_id, owner_process, owner_pid, acquired_at, heartbeat_at) VALUES (?,?,?,?,?,?)`,
      [lockId, project.id, 'integration-agent', process.pid, now, now]);

    dbRun(
      `INSERT INTO agent_executions (id, job_id, subtask_id, project_id, role, model, workspace_path, status, attempt, started_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [executionId, subtask.job_id, subtask.id, project.id, 'integration', integrationModel, project.workspace_path, 'running', 1]
    );

    activeExecutions.set(executionId, {
      role: 'integration',
      model: integrationModel,
      workspacePath: project.workspace_path,
      status: 'running',
      subtaskId: subtask.id,
      jobId: subtask.job_id
    });

    emitWebSocketEvent('integration.started', subtask, { executionId, role: 'integration' });

    const integrationPrompt = `Integrate the verified implementation from ${subtask.worktree_path || project.workspace_path} into the canonical project. Check for conflicts and run project-level verification.`;

    const args = ['-m', integrationModel, '--auto', '--pure', 'run', '--format', 'json', integrationPrompt];
    const env = { ...process.env, NINEROUTER_API_KEY };
    const child = spawn(OPENCODE_BIN, args, { cwd: project.workspace_path, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

    dbRun('UPDATE agent_executions SET process_pid = ?, process_identity = ? WHERE id = ?', [child.pid, `pid:${child.pid}:${executionId}`, executionId]);

    const taskLogger = new TaskLogger(`integration-${executionId}`);
    const outputChunks = [];

    child.stdout.on('data', (chunk) => {
      taskLogger.write(chunk);
      outputChunks.push(chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      taskLogger.write(chunk);
      outputChunks.push(chunk.toString());
    });

    const finishIntegration = async (exitCode) => {
      taskLogger.end();
      const output = outputChunks.join('');
      let verdict = 'FAILED';
      let evidence = {};
      try {
        const parsed = JSON.parse(output.trim().split('\n').pop() || '{}');
        if (parsed && typeof parsed === 'object') {
          verdict = parsed.verdict || 'PASS';
          evidence = parsed;
        }
      } catch {}

      ParallelScheduler.releaseSlot('integration');
      activeExecutions.delete(executionId);
      try { dbRun('DELETE FROM integration_locks WHERE project_id = ?', [project.id]); } catch {}

      const integratedRevision = await (async () => {
        try {
          return execSync('git rev-parse HEAD', { cwd: project.workspace_path }).toString().trim();
        } catch { return null; }
      })();

      dbRun(
        `INSERT INTO agent_integration_results (id, job_id, project_id, subtask_id, source_revision, integrated_revision, verdict, evidence_json, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [randomUUID(), subtask.job_id, project.id, subtask.id, subtask.source_revision || 'HEAD', integratedRevision, verdict, JSON.stringify(evidence)]
      );

      emitWebSocketEvent(verdict === 'PASS' ? 'integration.passed' : 'integration.failed', subtask, { executionId, verdict });

      if (verdict === 'PASS') {
        ParallelScheduler.updateState(subtask.id, 'completed', 'integration passed', 'integration');
        await import('./final-auditor.js').then(async ({ FinalAuditor }) => {
          await FinalAuditor.checkJobCompletion(subtask.job_id);
        });
      } else {
        ParallelScheduler.updateState(subtask.id, 'blocked', 'integration failed', 'integration');
      }
      Supervisor.schedule(subtask.job_id);
    };

    child.on('exit', finishIntegration);
    child.on('error', (err) => {
      taskLogger.end();
      ParallelScheduler.releaseSlot('integration');
      activeExecutions.delete(executionId);
      try { dbRun('DELETE FROM integration_locks WHERE project_id = ?', [project.id]); } catch {}
      ParallelScheduler.updateState(subtask.id, 'blocked', `Integration error: ${err.message}`, 'integration');
      Supervisor.schedule(subtask.job_id);
    });

    return executionId;
  }
}

export class FinalAuditor {
  static async checkJobCompletion(jobId) {
    const job = dbGetOne('SELECT * FROM jobs WHERE id = ?', [jobId]);
    const allSubtasks = dbGet('SELECT * FROM job_subtasks WHERE job_id = ?', [jobId]);
    const allAudits = dbGet('SELECT * FROM agent_audits WHERE job_id = ? AND verdict != ?', [jobId, 'PASS']);

    const passedCount = allSubtasks.filter(st => st.status === 'completed').length;
    const totalCount = allSubtasks.length;
    const completionPercent = totalCount > 0 ? Math.round((passedCount / totalCount) * 100) : 0;

    const finalVerdict = allAudits.length === 0 ? 'PASS' : 'FAILED';
    const finalAuditId = randomUUID();

    const prompt = `Final audit of job ${jobId}. Requirements: ${job.total_requirements}, Verified: ${passedCount}, Completion: ${completionPercent}%.

All subtasks: ${JSON.stringify(allSubtasks.map(st => ({ id: st.id, status: st.status })))}
Failed audits: ${allAudits.length}

Determine if the job should be marked COMPLETE or PARTIALLY_COMPLETED.`;

    const args = ['-m', DEFAULT_MODEL, '--auto', '--pure', 'run', '--format', 'json', prompt];
    const env = { ...process.env, NINEROUTER_API_KEY };
    const child = spawn(OPENCODE_BIN, args, { cwd: job.project_id ? '' : process.cwd(), env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

    const outputChunks = [];
    child.stdout.on('data', (chunk) => outputChunks.push(chunk.toString()));
    child.stderr.on('data', (chunk) => outputChunks.push(chunk.toString()));

    child.on('exit', async () => {
      const output = outputChunks.join('');
      let report = {};
      try { report = JSON.parse(output.trim().split('\n').pop() || '{}'); } catch {}

      const reportJson = JSON.stringify({
        jobId,
        finalVerdict,
        totalRequirements: job.total_requirements,
        verifiedRequirements: passedCount,
        completionPercent,
        subtasks: allSubtasks,
        audits: allAudits,
        report
      });

      dbRun(
        `UPDATE jobs SET status = ?, final_audit_verdict = ?, verified_requirements = ?, completion_percent = ?, report_json = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        [finalVerdict === 'PASS' ? 'completed' : 'partially_completed', finalVerdict, passedCount, completionPercent, reportJson, jobId]
      );

      emitWebSocketEvent(finalVerdict === 'PASS' ? 'job.completed' : 'job.partially_completed', { job_id: jobId }, { completionPercent, finalVerdict, report });
    });
  }
}
