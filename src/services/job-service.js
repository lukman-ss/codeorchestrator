import { dbGetOne, dbGet } from '../database/db.js';

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
