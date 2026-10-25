import { listAllTasks, getTask, getTaskEvents } from '../services/task-service.js';
import { cancelTask } from '../services/task-queue.js';

export default async function tasks(app) {
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
      cancelTask(req.params.taskId);
      reply.send({ id: req.params.taskId, status: 'cancelled' });
    } catch (e) { reply.code(400).send({ error: e.message }); }
  });
}
