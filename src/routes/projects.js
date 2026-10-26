import { z } from 'zod';
import * as ps from '../services/project-service.js';
import * as ts from '../services/task-service.js';
import * as ss from '../services/session-service.js';
import { enqueueTask } from '../services/task-queue.js';

const projectSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  repoUrl: z.string().url().optional(),
  defaultModel: z.string().optional(),
  isTest: z.union([z.boolean(), z.number()]).optional(),
  metadata: z.record(z.any()).optional()
});

const taskSchema = z.object({
  prompt: z.string().min(1).max(10000),
  model: z.string().optional(),
  sessionId: z.string().uuid().optional()
});

const projectSessionSchema = z.object({
  title: z.string().optional(),
  model: z.string().optional(),
  userId: z.string().optional(),
  metadata: z.record(z.any()).optional()
});

export default async function projects(app) {
  app.get('/', async (req) => ps.listProjects(req.query));

  app.post('/', async (req, reply) => {
    try {
      const data = projectSchema.parse(req.body);
      const isTestFlag = data.isTest === true || data.isTest === 1 || req.headers['x-test-mode'] === 'true' || false;
      reply.code(201).send(ps.createProject({ ...data, isTest: isTestFlag }));
    } catch (e) {
      reply.code(400).send({ error: e.message });
    }
  });

  app.get('/:id', async (req, reply) => {
    try {
      reply.send(ps.getProject(req.params.id));
    } catch (e) {
      reply.code(404).send({ error: e.message });
    }
  });

  app.patch('/:id', async (req, reply) => {
    try {
      reply.send(ps.updateProject(req.params.id, req.body));
    } catch (e) {
      reply.code(404).send({ error: e.message });
    }
  });

  app.post('/import', async (req, reply) => {
    try {
      reply.send(ps.importProject(req.body.slug));
    } catch (e) {
      reply.code(400).send({ error: e.message });
    }
  });

  app.get('/:id/tasks', async (req, reply) => {
    try {
      reply.send(ts.listTasks(req.params.id));
    } catch (e) {
      reply.code(404).send({ error: e.message });
    }
  });

  app.post('/:id/tasks', async (req, reply) => {
    try {
      const { checkDiskSpace } = await import('../services/task-queue.js');
      if (!checkDiskSpace()) {
        reply.code(507).send({ error: 'Insufficient disk space to execute new tasks' });
        return;
      }
      const data = taskSchema.parse(req.body);
      const task = ts.createTask(req.params.id, data);
      enqueueTask(task.id);
      reply.code(201).send({ id: task.id, status: task.status });
    } catch (e) {
      reply.code(400).send({ error: e.message });
    }
  });

  // List sessions associated with this project
  app.get('/:id/sessions', async (req, reply) => {
    try {
      reply.send(ss.listSessions({ projectId: req.params.id }));
    } catch (e) {
      reply.code(404).send({ error: e.message });
    }
  });

  // Create session associated with this project
  app.post('/:id/sessions', async (req, reply) => {
    try {
      const data = projectSessionSchema.parse(req.body || {});
      const session = ss.createSession({
        projectId: req.params.id,
        type: 'project',
        title: data.title,
        model: data.model,
        userId: data.userId,
        metadata: data.metadata
      });
      reply.code(201).send(session);
    } catch (e) {
      const status = e.message.includes('not found') ? 404 : 400;
      reply.code(status).send({ error: e.message });
    }
  });
}
