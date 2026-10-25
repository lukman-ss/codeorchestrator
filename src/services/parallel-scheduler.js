import { dbGet, dbRun, dbGetOne } from '../database/db.js';
import { MAX_PARALLEL_WORKERS, MAX_PARALLEL_AUDITORS, MAX_PARALLEL_INTEGRATIONS, MAX_GLOBAL_AGENT_PROCESSES } from '../config.js';
import logger from '../logger.js';

export class ParallelScheduler {
  static MAX_PARALLEL_WORKERS = MAX_PARALLEL_WORKERS;
  static MAX_PARALLEL_AUDITORS = MAX_PARALLEL_AUDITORS;
  static MAX_PARALLEL_INTEGRATIONS = MAX_PARALLEL_INTEGRATIONS;
  static MAX_GLOBAL_AGENT_PROCESSES = MAX_GLOBAL_AGENT_PROCESSES;

  static runningByRole = { worker: 0, auditor: 0, integration: 0, supervisor: 0, repair: 0 };
  static globalRunning = 0;

  static getGlobalRunning() {
    return this.globalRunning;
  }

  static getRunningByRole() {
    return { ...this.runningByRole };
  }

  static hasCapacity(role) {
    const roleMax = {
      worker: this.MAX_PARALLEL_WORKERS,
      auditor: this.MAX_PARALLEL_AUDITORS,
      integration: this.MAX_PARALLEL_INTEGRATIONS,
      supervisor: 1,
      repair: 1
    };
    return (
      this.globalRunning < this.MAX_GLOBAL_AGENT_PROCESSES &&
      (this.runningByRole[role] || 0) < (roleMax[role] || 1)
    );
  }

  static claimSlot(role) {
    if (!this.hasCapacity(role)) return false;
    this.globalRunning++;
    this.runningByRole[role] = (this.runningByRole[role] || 0) + 1;
    return true;
  }

  static releaseSlot(role) {
    if (this.globalRunning > 0) this.globalRunning--;
    if (this.runningByRole[role]) this.runningByRole[role]--;
  }

  static getEligibleSubtasks(jobId) {
    const allSubtasks = dbGet(
      'SELECT * FROM job_subtasks WHERE job_id = ? ORDER BY priority ASC, created_at ASC',
      [jobId]
    );
    const subtaskMap = new Map(allSubtasks.map(st => [st.id, { ...st, dependsOn: JSON.parse(st.depends_on_json || '[]') }]));
    const completed = new Set(
      dbGet('SELECT id FROM job_subtasks WHERE job_id = ? AND status = ?', [jobId, 'integration_passed'])
        .map(r => r.id)
    );

    const result = [];
    for (const st of allSubtasks) {
      if (['completed', 'integration_passed', 'blocked'].includes(st.status)) continue;
      const deps = JSON.parse(st.depends_on_json || '[]');
      if (deps.length === 0) {
        result.push(st.id);
        continue;
      }
      const depsMet = deps.every(d => completed.has(d));
      if (depsMet) result.push(st.id);
    }
    return result;
  }

  static findNextExecutableSubtasks(jobId) {
    const eligible = this.getEligibleSubtasks(jobId);
    const candidates = [];
    for (const id of eligible) {
      const st = dbGetOne('SELECT * FROM job_subtasks WHERE id = ? AND status = ?', [id, 'pending']);
      if (st && this.hasCapacity('worker')) {
        candidates.push(st);
      }
    }
    return candidates;
  }

  static detectCycle(jobId) {
    const allSubtasks = dbGet('SELECT id, depends_on_json FROM job_subtasks WHERE job_id = ?', [jobId]);
    const map = new Map(allSubtasks.map(st => [st.id, JSON.parse(st.depends_on_json || '[]')]));
    const visited = new Set();
    const recursionStack = new Set();

    const hasCycle = (id) => {
      if (recursionStack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      recursionStack.add(id);
      const deps = map.get(id) || [];
      for (const dep of deps) {
        if (hasCycle(dep)) return true;
      }
      recursionStack.delete(id);
      return false;
    };

    for (const id of map.keys()) {
      visited.clear();
      recursionStack.clear();
      if (hasCycle(id)) return true;
    }
    return false;
  }

  static updateState(subtaskId, toStatus, reason, actor) {
    const fromStatus = dbGetOne('SELECT status FROM job_subtasks WHERE id = ?', [subtaskId])?.status;
    dbRun("UPDATE job_subtasks SET status = ?, updated_at = datetime('now') WHERE id = ?", [toStatus, subtaskId]);
    dbRun(
      'INSERT INTO subtask_state_events (job_id, subtask_id, from_status, to_status, reason, actor) VALUES (?, ?, ?, ?, ?, ?)',
      [dbGetOne('SELECT job_id FROM job_subtasks WHERE id = ?', [subtaskId])?.job_id, subtaskId, fromStatus, toStatus, reason, actor]
    );
  }

  static validateSubtaskStatusTransition(from, to) {
    const valid = {
      pending: ['queued', 'blocked', 'cancelled'],
      queued: ['running', 'blocked', 'cancelled'],
      running: ['implementation_done', 'blocked', 'cancelled', 'interrupted'],
      implementation_done: ['audit_pending', 'blocked', 'integration_pending'],
      audit_pending: ['auditing', 'blocked'],
      auditing: ['audit_passed', 'audit_failed', 'blocked'],
      audit_passed: ['integration_pending', 'blocked'],
      audit_failed: ['repair_pending', 'blocked'],
      repair_pending: ['repair_running', 'blocked'],
      repair_running: ['audit_pending', 'blocked', 'integration_pending'],
      integration_pending: ['integrating', 'blocked'],
      integrating: ['integration_passed', 'integration_failed', 'blocked'],
      integration_passed: ['completed', 'blocked'],
      completed: [],
      blocked: ['pending', 'cancelled'],
      cancelled: [],
      interrupted: []
    };
    return (valid[from] || []).includes(to);
  }
}