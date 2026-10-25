import { getJob, listJobs, getJobReport } from '../services/job-service.js';
import { getSubtask, listSubtasks, getSubtaskAudits, getSubtaskExecutions } from '../services/subtask-service.js';
import { getAgentCapacity } from '../services/agent-capacity.js';

export default async function api(app) {
  app.get('/jobs/:id/agents', async (req, reply) => {
    try {
      const agents = await getAgentCapacity(req.params.id);
      reply.send(agents);
    } catch (e) {
      reply.code(500).send({ error: e.message });
    }
  });

  app.get('/jobs/:id/audits', async (req, reply) => {
    try { reply.send(await getJobReport(req.params.id)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });

  app.get('/jobs/:id/integrations', async (req, reply) => {
    try { reply.send(await getJobReport(req.params.id)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });

  app.get('/jobs/:id/execution-graph', async (req, reply) => {
    try { reply.send(await getJobReport(req.params.id)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });

  app.get('/subtasks/:id/audit', async (req, reply) => {
    try { reply.send(await getSubtaskAudits(req.params.id)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });

  app.get('/subtasks/:id/executions', async (req, reply) => {
    try { reply.send(await getSubtaskExecutions(req.params.id)); } catch (e) { reply.code(404).send({ error: e.message }); }
  });

  app.post('/subtasks/:id/retry', async (req, reply) => {
    try { await retrySubtask(req.params.id); reply.send({ status: 'retry_scheduled' }); } catch (e) { reply.code(400).send({ error: e.message }); }
  });

  app.post('/subtasks/:id/reaudit', async (req, reply) => {
    try { await scheduleReaudit(req.params.id); reply.send({ status: 'reaudit_scheduled' }); } catch (e) { reply.code(400).send({ error: e.message }); }
  });
}
