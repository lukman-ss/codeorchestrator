import { Supervisor } from '../services/supervisor.js';
import { dbGetOne, dbGet } from '../database/db.js';
import { getJob, listJobs, getJobReport, cancelJob } from '../services/job-service.js';

export const registerJobRoutes = (app) => {
  app.get('/jobs', async (req) => {
    const projectId = req.query?.project_id;
    return listJobs(projectId);
  });

  app.post('/jobs', async (req, reply) => {
    try {
      const { project_id, prompt } = req.body;
      if (!project_id || !prompt) {
        reply.code(400).send({ error: 'project_id and prompt are required' });
        return;
      }
      const result = await Supervisor.createJob(project_id, prompt);
      reply.code(201).send({ id: result.jobId, subtaskId: result.subtaskId });
    } catch (e) {
      reply.code(500).send({ error: e.message });
    }
  });

  app.get('/jobs/:id', async (req, reply) => {
    try {
      const job = getJob(req.params.id);
      if (!job) {
        reply.code(404).send({ error: 'Job not found' });
        return;
      }
      reply.send(job);
    } catch (e) {
      reply.code(500).send({ error: e.message });
    }
  });

  app.get('/jobs/:id/subtasks', async (req, reply) => {
    try {
      const subtasks = dbGet('SELECT * FROM job_subtasks WHERE job_id = ?', [req.params.id]);
      reply.send(subtasks);
    } catch (e) {
      reply.code(500).send({ error: e.message });
    }
  });

  app.get('/jobs/:id/report', async (req, reply) => {
    try {
      const job = getJob(req.params.id);
      if (!job) {
        reply.code(404).send({ error: 'Job not found' });
        return;
      }
      const report = getJobReport(req.params.id);
      reply.send(report || {
        jobId: job.id,
        status: job.status,
        finalVerdict: job.final_audit_verdict || 'PENDING',
        totalRequirements: job.total_requirements,
        verifiedRequirements: job.verified_requirements,
        completionPercent: job.completion_percent
      });
    } catch (e) {
      reply.code(500).send({ error: e.message });
    }
  });

  app.post('/jobs/:id/cancel', async (req, reply) => {
    try {
      const job = getJob(req.params.id);
      if (!job) {
        reply.code(404).send({ error: 'Job not found' });
        return;
      }
      const res = cancelJob(req.params.id);
      reply.send(res);
    } catch (e) {
      reply.code(500).send({ error: e.message });
    }
  });
};
