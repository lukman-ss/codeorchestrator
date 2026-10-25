import { dbGetOne, dbGet } from '../database/db.js';

export const getSubtask = (id) => {
  return dbGetOne('SELECT * FROM job_subtasks WHERE id = ?', [id]);
};

export const listSubtasks = (jobId) => {
  if (jobId) {
    return dbGet('SELECT * FROM job_subtasks WHERE job_id = ? ORDER BY created_at ASC', [jobId]);
  }
  return dbGet('SELECT * FROM job_subtasks ORDER BY created_at ASC');
};

export const getSubtaskAudits = (subtaskId) => {
  return dbGet('SELECT * FROM agent_audits WHERE subtask_id = ? ORDER BY created_at DESC', [subtaskId]);
};

export const getSubtaskExecutions = (subtaskId) => {
  return dbGet('SELECT * FROM agent_executions WHERE subtask_id = ? ORDER BY started_at ASC', [subtaskId]);
};
