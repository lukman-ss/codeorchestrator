import { z } from 'zod';
import * as ss from '../services/session-service.js';
import * as ts from '../services/task-service.js';
import { MAX_PROMPT_LENGTH } from '../config.js';

const createSessionSchema = z.object({
  title: z.string().optional(),
  type: z.enum(['standalone', 'project']).optional(),
  projectId: z.string().uuid().optional().nullable(),
  project_id: z.string().uuid().optional().nullable(),
  model: z.string().nullish(),
  userId: z.string().nullish(),
  user_id: z.string().nullish(),
  metadata: z.record(z.any()).nullish()
});

const patchSessionSchema = z.object({
  title: z.string().optional(),
  model: z.string().nullish(),
  status: z.enum(['created', 'active', 'idle', 'interrupted', 'closed']).optional(),
  userId: z.string().nullish(),
  user_id: z.string().nullish(),
  metadata: z.record(z.any()).nullish(),
  projectId: z.string().nullish(),
  project_id: z.string().nullish(),
  type: z.string().optional(),
  session_type: z.string().optional()
});

const messageSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  model: z.string().nullish(),
  userId: z.string().nullish()
});

export default async function sessions(app) {
  // List sessions (standalone and/or project-linked)
  app.get('/', async (req, reply) => {
    try {
      const items = ss.listSessions(req.query);
      reply.send(items);
    } catch (e) {
      reply.code(400).send({ error: e.message });
    }
  });

  // Create standalone session (or project-linked if projectId specified)
  app.post('/', async (req, reply) => {
    try {
      const data = createSessionSchema.parse(req.body || {});
      const session = ss.createSession({
        title: data.title,
        type: data.type || (data.projectId || data.project_id ? 'project' : 'standalone'),
        projectId: data.projectId || data.project_id || null,
        model: data.model,
        userId: data.userId || data.user_id,
        metadata: data.metadata
      });
      reply.code(201).send(session);
    } catch (e) {
      reply.code(400).send({ error: e.message });
    }
  });

  // Get session details
  app.get('/:id', async (req, reply) => {
    try {
      reply.send(ss.getSession(req.params.id));
    } catch (e) {
      reply.code(404).send({ error: e.message });
    }
  });

  // Update session
  app.patch('/:id', async (req, reply) => {
    try {
      const patch = patchSessionSchema.parse(req.body || {});
      reply.send(ss.updateSession(req.params.id, patch));
    } catch (e) {
      const status = e.message.includes('not found') ? 404 : 400;
      reply.code(status).send({ error: e.message });
    }
  });

  // Delete session
  app.delete('/:id', async (req, reply) => {
    try {
      reply.send(ss.deleteSession(req.params.id));
    } catch (e) {
      reply.code(404).send({ error: e.message });
    }
  });

  // List messages in session
  app.get('/:id/messages', async (req, reply) => {
    try {
      reply.send(ss.listSessionMessages(req.params.id));
    } catch (e) {
      reply.code(404).send({ error: e.message });
    }
  });

  // Execute conversation message with real OpenCode continuation
  app.post('/:id/messages', async (req, reply) => {
    try {
      const { prompt, model, userId } = messageSchema.parse(req.body);
      const result = await ss.executeSessionMessage(req.params.id, { prompt, model, userId });
      reply.send(result);
    } catch (e) {
      if (e.message.includes('not found')) {
        reply.code(404).send({ error: e.message });
      } else if (e.message.includes('Unauthorized')) {
        reply.code(403).send({ error: e.message });
      } else if (e.message.includes('closed')) {
        reply.code(409).send({ error: e.message });
      } else {
        reply.code(500).send({ error: e.message });
      }
    }
  });

  // List tasks associated with session (if project-linked)
  app.get('/:id/tasks', async (req, reply) => {
    try {
      const s = ss.getSession(req.params.id);
      if (!s.project_id) {
        reply.send([]);
        return;
      }
      const tasks = ts.listTasks(s.project_id).filter(t => t.session_id === req.params.id);
      reply.send(tasks);
    } catch (e) {
      reply.code(404).send({ error: e.message });
    }
  });
}
