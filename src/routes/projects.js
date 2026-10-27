import { z } from 'zod';
import * as ps from '../services/project-service.js';
import * as ts from '../services/task-service.js';
import * as ss from '../services/session-service.js';
import * as po from '../services/project-operations.js';
import { enqueueTask } from '../services/task-queue.js';
import { MAX_PROMPT_LENGTH } from '../config.js';

const projectSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().optional(),
  repoUrl: z.string().optional(),
  repositoryUrl: z.string().optional(),
  branch: z.string().optional(),
  defaultBranch: z.string().optional(),
  defaultModel: z.string().optional(),
  initGit: z.boolean().optional(),
  isTest: z.union([z.boolean(), z.number()]).optional(),
  userId: z.string().optional(),
  creatorUserId: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  async: z.boolean().optional()
});

const taskSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  model: z.string().nullish(),
  sessionId: z.string().uuid().nullish()
});

const projectSessionSchema = z.object({
  title: z.string().optional(),
  model: z.string().nullish(),
  userId: z.string().nullish(),
  metadata: z.record(z.any()).nullish()
});

export default async function projects(app) {
  app.get('/', async (req) => ps.listProjects(req.query));

  app.post('/', async (req, reply) => {
    try {
      const data = projectSchema.parse(req.body);
      const isTestFlag =
        data.isTest === true ||
        data.isTest === 1 ||
        req.headers['x-test-mode'] === 'true' ||
        false;

      if (data.async) {
        const op = await po.startCreateOperation({ ...data, isTest: isTestFlag });
        return reply.code(202).send(op);
      }

      const project = ps.createProject({ ...data, isTest: isTestFlag });
      reply.code(201).send(project);
    } catch (e) {
      reply.code(400).send({ error: e.message });
    }
  });

  app.get('/operations/:id', async (req, reply) => {
    const op = po.getProjectOperation(req.params.id);
    if (!op) {
      return reply.code(404).send({ error: 'Operation not found' });
    }
    reply.send(op);
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

  app.post('/:id/repair', async (req, reply) => {
    try {
      const { repoUrl, defaultBranch, confirm } = req.body || {};
      const result = ps.repairProject(req.params.id, { repoUrl, defaultBranch, confirm, userId: req.user?.id });
      reply.send(result);
    } catch (e) {
      reply.code(400).send({ error: e.message });
    }
  });

  app.get('/:id/validate', async (req, reply) => {
    try {
      const project = ps.getProject(req.params.id);
      const result = ps.validateProjectWorkspace(project, req.query || {});
      reply.send(result);
    } catch (e) {
      reply.code(404).send({ error: e.message });
    }
  });

  app.post('/import', async (req, reply) => {
    try {
      const slugOrDir = req.body?.directory || req.body?.slug;
      const name = req.body?.name;
      const isTest =
        req.body?.isTest === true ||
        req.body?.isTest === 1 ||
        req.headers['x-test-mode'] === 'true' ||
        process.env.NODE_ENV === 'test' ||
        false;
      const userId = req.body?.userId;
      reply.send(ps.importProject(slugOrDir, { name, isTest, userId }));
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
        ...data,
        type: 'project',
        projectId: req.params.id
      });
      reply.code(201).send(session);
    } catch (e) {
      reply.code(e.message === 'Project not found' ? 404 : 400).send({ error: e.message });
    }
  });
}
