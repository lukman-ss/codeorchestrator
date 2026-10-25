import { Supervisor } from '../services/supervisor.js';
import { dbGetOne, dbGet } from '../database/db.js';

export const registerJobRoutes = (app) => {
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
      const job = dbGetOne('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
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
};
