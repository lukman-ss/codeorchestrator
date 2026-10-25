import { z } from 'zod';
import * as ss from '../services/session-service.js';
import * as ts from '../services/task-service.js';

const sessionSchema = z.object({
  model: z.string().optional(),
  title: z.string().optional()
});

export default async function sessions(app) {
  app.get('/:id', async (req, reply) => {
    try { reply.send(ss.getSession(req.params.id)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });
  app.patch('/:id', async (req, reply) => {
    try { reply.send(ss.updateSession(req.params.id, req.body)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });
  app.get('/:id/tasks', async (req, reply) => {
    try {
      const s = ss.getSession(req.params.id);
      const tasks = ts.listTasks(s.project_id).filter(t => t.session_id === req.params.id);
      reply.send(tasks);
    } catch (e) { reply.code(404).send({ error: e.message }); }
  });
}
