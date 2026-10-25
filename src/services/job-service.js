import { dbGetOne, dbGet, dbRun } from '../database/db.js';
import { activeExecutions } from './agent-execution-engine.js';
import { emitWebSocketEvent } from '../realtime/event-bus.js';
import { ParallelScheduler } from './parallel-scheduler.js';

export const getJob = (id) => {
  return dbGetOne('SELECT * FROM jobs WHERE id = ?', [id]);
};

export const listJobs = (projectId) => {
  if (projectId) {
    return dbGet('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
  }
  return dbGet('SELECT * FROM jobs ORDER BY created_at DESC');
};

export const getJobReport = (id) => {
  const job = getJob(id);
  if (!job) return null;
  return job.report_json ? JSON.parse(job.report_json) : null;
};

export const cancelJob = (id) => {
  const job = getJob(id);
  if (!job) return null;
  const terminal = ['completed', 'partially_completed', 'failed', 'cancelled', 'interrupted'];
  if (terminal.includes(job.status)) {
    return { id, status: job.status, terminal: true };
  }
  dbRun("UPDATE jobs SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [id]);
  dbRun("UPDATE job_subtasks SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now') WHERE job_id = ? AND status NOT IN ('completed', 'cancelled')", [id]);

  if (activeExecutions) {
    for (const [execId, exec] of activeExecutions.entries()) {
      if (exec.jobId === id) {
        if (exec.process && !exec.process.killed) {
          try { exec.process.kill('SIGTERM'); } catch {}
        }
        if (exec.role) {
          try { ParallelScheduler.releaseSlot(exec.role); } catch {}
        }
        activeExecutions.delete(execId);
      }
    }
  }

  emitWebSocketEvent('job.cancelled', { job_id: id }, { id, status: 'cancelled' });
  return { id, status: 'cancelled' };
};
