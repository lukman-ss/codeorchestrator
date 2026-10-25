import { z } from 'zod';
import { listAllTasks, getTask, getTaskEvents, listTasks } from '../services/task-service.js';
import { cancelTask, checkDiskSpace } from '../services/task-queue.js';
import logger from '../logger.js';

const taskSchema = z.object({
  prompt: z.string().min(1).max(10000),
  model: z.string().optional(),
  sessionId: z.string().uuid().optional()
});

export async function projects(app) {
  app.get('/', async () => (await import('../services/project-service.js')).listProjects());
  app.post('/', async (req, reply) => {
    try {
      const { z } = await import('zod');
      const schema = z.object({
        name: z.string().min(1),
        slug: z.string().regex(/^[a-z0-9-]+$/),
        repoUrl: z.string().url().optional(),
        defaultModel: z.string().optional()
      });
      const data = schema.parse(req.body);
      reply.code(201).send((await import('../services/project-service.js')).createProject(data));
    } catch (e) { reply.code(400).send({ error: e.message }); }
  });
  app.get('/:id', async (req, reply) => {
    try { reply.send((await import('../services/project-service.js')).getProject(req.params.id)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });
  app.patch('/:id', async (req, reply) => {
    try { reply.send((await import('../services/project-service.js')).updateProject(req.params.id, req.body)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });
  app.post('/import', async (req, reply) => {
    try { reply.send((await import('../services/project-service.js')).importProject(req.body.slug)); } catch (e) { reply.code(400).send({ error: e.message }); }
  });
  app.get('/:id/tasks', async (req, reply) => {
    try { reply.send(listTasks(req.params.id)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });
  app.post('/:id/tasks', async (req, reply) => {
    try {
      if (!checkDiskSpace()) { reply.code(507).send({ error: 'Insufficient disk space' }); return; }
      const data = taskSchema.parse(req.body);
      const { createTask, enqueueTask } = await import('../services/task-service.js');
      const task = createTask(req.params.id, data);
      (await import('../services/task-queue.js')).enqueueTask(task.id);
      reply.code(201).send({ id: task.id, status: task.status });
    } catch (e) { reply.code(400).send({ error: e.message }); }
  });
  app.get('/:id/sessions', async (req, reply) => {
    try { reply.send((await import('../services/session-service.js')).listSessions(req.params.id)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });
}

export async function tasks(app) {
  app.get('/', async () => listAllTasks());
  app.get('/:id', async (req, reply) => {
    try { reply.send(getTask(req.params.id)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });
  app.get('/:id/events', async (req, reply) => {
    try { reply.send(getTaskEvents(req.params.id, Number(req.query.afterSequence) || 0)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });
  app.post('/:taskId/cancel', async (req, reply) => {
    try {
      const task = getTask(req.params.taskId);
      if (!['queued', 'running'].includes(task.status)) { reply.code(409).send({ error: 'Cannot cancel' }); return; }
      cancelTask(req.params.taskId);
      reply.send({ id: req.params.taskId, status: 'cancelled' });
    } catch (e) { reply.code(400).send({ error: e.message }); }
  });
}

export async function sessions(app) {
  app.get('/:id', async (req, reply) => {
    try { reply.send((await import('../services/session-service.js')).getSession(req.params.id)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });
  app.patch('/:id', async (req, reply) => {
    try { reply.send((await import('../services/session-service.js')).updateSession(req.params.id, req.body)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });
  app.get('/:id/tasks', async (req, reply) => {
    try {
      const s = (await import('../services/session-service.js')).getSession(req.params.id);
      const tasks = listTasks(s.project_id).filter(t => t.session_id === req.params.id);
      reply.send(tasks);
    } catch (e) { reply.code(404).send({ error: e.message }); }
  });
}
