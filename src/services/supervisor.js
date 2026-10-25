import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { dbGetOne, dbRun, dbGet } from '../database/db.js';
import { RequirementExtractor } from './requirement-extractor.js';
import { ParallelScheduler } from './parallel-scheduler.js';
import logger from '../logger.js';
import { emitWebSocketEvent } from '../realtime/event-bus.js';
import { AgentExecutionEngine } from './agent-execution-engine.js';

export class Supervisor {
  static async createJob(projectId, prompt) {
    const jobId = randomUUID();
    const promptHash = createHash('sha256').update(prompt).digest('hex');
    const requirements = RequirementExtractor.extract(prompt);
    const totalReq = requirements.length;

    dbRun(
      `INSERT INTO jobs (id, project_id, prompt, prompt_hash, status, total_requirements, created_at) VALUES (?,?,?,?,?, ?, datetime('now'))`,
      [jobId, projectId, prompt, promptHash, 'planning', totalReq]
    );

    for (const r of requirements) {
      dbRun(
        `INSERT INTO job_requirements (id, job_id, requirement_id, requirement_text, section_reference, acceptance_criteria_json, mandatory, source_location) VALUES (?,?,?,?,?,?,?,?)`,
        [randomUUID(), jobId, r.requirement_id, r.requirement_text, r.section_reference, JSON.stringify(r.acceptance_criteria), r.mandatory ? 1 : 0, r.source_location]
      );
    }

    const subtaskIds = [];
    const idByReqId = new Map();

    for (const r of requirements) {
      const subtaskId = randomUUID();
      const depJson = Array.isArray(r.depends_on) ? JSON.stringify(r.depends_on) : '[]';
      dbRun(
        `INSERT INTO job_subtasks (id, job_id, project_id, subtask_id, title, description, prompt, acceptance_criteria_json, role, status, depends_on_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`,
        [subtaskId, jobId, projectId, r.requirement_id, r.requirement_text, r.requirement_text, r.requirement_text, JSON.stringify({ criteria: r.acceptance_criteria, force_fail: r.force_fail }), 'worker', 'pending', depJson]
      );
      subtaskIds.push(subtaskId);
      idByReqId.set(r.requirement_id, subtaskId);
    }

    const edges = [];
    for (const r of requirements) {
      if (Array.isArray(r.depends_on)) {
        for (const parentReqId of r.depends_on) {
          const parentId = idByReqId.get(parentReqId);
          const childId = idByReqId.get(r.requirement_id);
          if (parentId && childId) {
            edges.push([randomUUID(), jobId, parentId, childId]);
          }
        }
      }
    }

    for (const e of edges) {
      dbRun(`INSERT INTO dependency_edges (id, job_id, parent_subtask_id, child_subtask_id) VALUES (?,?,?,?)`, e);
    }

    dbRun(`UPDATE jobs SET status='running', started_at=datetime('now') WHERE id=?`, [jobId]);
    logger.info({ jobId, projectId, requirements: totalReq, subtasks: subtaskIds.length, deps: edges.length }, 'Job created and scheduled');

    emitWebSocketEvent('job.created', { job_id: jobId }, { requirements: totalReq, subtasks: subtaskIds.length, dependencies: edges.length });

    Supervisor.schedule(jobId);

    return { jobId, subtaskId: subtaskIds[0], subtaskIds };
  }

  static schedule(jobId) {
    if (ParallelScheduler.detectCycle(jobId)) {
      ParallelScheduler.updateState(null, 'blocked', 'dependency cycle detected', 'supervisor');
      logger.error({ jobId }, 'Dependency cycle detected, job blocked');
      return;
    }
    const candidates = ParallelScheduler.findNextExecutableSubtasks(jobId);
    for (const st of candidates) {
      if (ParallelScheduler.claimSlot('worker')) {
        ParallelScheduler.updateState(st.id, 'queued', 'scheduled by supervisor', 'supervisor');
        AgentExecutionEngine.startWorker(st);
      }
    }
  }
}
