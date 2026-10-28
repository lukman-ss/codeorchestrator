import { listAllTasks, getTask, getTaskEvents, recoverBlockedTask, findRecoverableTask } from '../services/task-service.js';
import { TaskContextService } from '../services/task-context-service.js';
import { cancelTask } from '../services/task-queue.js';

export default async function tasks(app) {
  app.get('/', async () => listAllTasks());
  app.get('/recoverable', async (req, reply) => {
    try {
      const task = findRecoverableTask(req.query || {});
      if (!task) return reply.code(404).send({ error: 'No recoverable task found' });
      reply.send(task);
    } catch (e) {
      reply.code(e.ambiguous ? 409 : 400).send({
        error: e.message,
        ambiguous: Boolean(e.ambiguous),
        candidates: e.candidates || []
      });
    }
  });
  app.get('/:id', async (req, reply) => {
    try { reply.send(getTask(req.params.id)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });
  app.get('/:id/events', async (req, reply) => {
    try { reply.send(getTaskEvents(req.params.id, Number(req.query.afterSequence) || 0)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });
  app.get('/:id/context', async (req, reply) => {
    try {
      const snap = TaskContextService.getSnapshot(req.params.id);
      if (!snap) return reply.code(404).send({ error: 'Task context snapshot not found' });
      reply.send(snap);
    } catch (e) { reply.code(404).send({ error: e.message }); }
  });
  app.post('/:id/recover', async (req, reply) => {
    try {
      const result = await recoverBlockedTask(req.params.id, req.body || {});
      reply.send(result);
    } catch (e) { reply.code(400).send({ error: e.message }); }
  });
  app.post('/:taskId/cancel', async (req, reply) => {
    try {
      const task = getTask(req.params.taskId);
      cancelTask(req.params.taskId);
      reply.send({ id: req.params.taskId, status: 'cancelled' });
    } catch (e) { reply.code(400).send({ error: e.message }); }
  });
}
