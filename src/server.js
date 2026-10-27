import Fastify from 'fastify';
import { PORT, HOST, API_AUTH_TOKEN, DATABASE_PATH, DISK_FREE_THRESHOLD_MB, REQUIRE_AUTH } from './config.js';
import { init as initDb, close as closeDb } from './database/db.js';
import { recoverOperations } from './services/project-operations.js';
import { recoverSessions } from './services/session-service.js';
import { recoverRunning, startFromQueue, getGlobalRunning, getDiskStats, shutdownAll, checkDiskSpace, getDispatchQueue, blockDispatch } from './services/task-queue.js';
import { cleanupTaskLogs } from './services/task-logger.js';
import { scheduleCleanup } from './services/maintenance.js';
import projects from './routes/projects.js';
import tasks from './routes/tasks.js';
import sessions from './routes/sessions.js';
import jobs from './routes/jobs.js';
import approvals from './routes/approvals.js';
import { setupWebSocket, shutdownWebSocket } from './realtime/websocket.js';
import { registerJobRoutes } from './routes/job-routes.js';
import { WorkflowService } from './services/workflow-service.js';
import logger from './logger.js';

if (REQUIRE_AUTH && !API_AUTH_TOKEN) {
  logger.fatal({ event: 'missing_auth_token' }, 'ORCHESTRATOR_API_TOKEN must be set when REQUIRE_AUTH is true');
  process.exit(1);
}

const fastify = Fastify({
  loggerInstance: logger,
  ajv: { settings: { allErrors: true } }
});

fastify.addHook('onRequest', (request, reply, done) => {
  request.requestId = request.headers['x-request-id'] || request.id;
  done();
});

fastify.addHook('preHandler', async (request, reply) => {
  if (REQUIRE_AUTH && API_AUTH_TOKEN && !request.url.startsWith('/health') && !request.url.startsWith('/ready')) {
    const auth = request.headers.authorization;
    if (!auth || auth !== `Bearer ${API_AUTH_TOKEN}`) {
      reply.code(401);
      return reply.send({ error: 'Unauthorized' });
    }
  }
});

fastify.get('/health', async () => {
  const stats = getDiskStats();
  return {
    status: 'ok',
    pid: process.pid,
    globalRunning: getGlobalRunning(),
    queueDepth: getDispatchQueue().length,
    diskFreeMB: stats.availableMB,
    diskUsagePercent: stats.usePercent,
    diskThresholdMB: DISK_FREE_THRESHOLD_MB
  };
});

fastify.get('/ready', async () => ({ ready: true }));

fastify.register(projects, { prefix: '/projects' });
fastify.register(tasks, { prefix: '/tasks' });
fastify.register(sessions, { prefix: '/sessions' });
fastify.register(jobs);
fastify.register(approvals);
registerJobRoutes(fastify);

const server = fastify.server;
const wss = setupWebSocket(server);

initDb();
recoverOperations();
recoverSessions();
recoverRunning();
WorkflowService.recoverPendingWorkflows();
scheduleCleanup();
setInterval(cleanupTaskLogs, 24 * 3600 * 1000);
startFromQueue();

fastify.listen({ port: PORT, host: HOST }).then(() => {
  logger.info({ event: 'server_started', port: PORT, host: HOST, db: DATABASE_PATH }, 'Server ready');
});

const gracefulShutdown = async (signal) => {
  logger.info({ event: 'shutdown_signal_received', signal }, 'Shutting down gracefully');
  blockDispatch();
  try {
    await fastify.close();
    logger.info({ event: 'http_closed' }, 'HTTP server closed');
  } catch (err) {
    logger.error({ err, event: 'shutdown_http_error' }, 'Error closing HTTP server');
  }
  try { shutdownAll(); } catch (e) { logger.error({ e, event: 'shutdown_tasks_error' }, 'Error shutting down tasks'); }
  const graceMs = (Number(process.env.TASK_KILL_GRACE_SECONDS) || 10) * 1000 + 500;
  logger.info({ graceMs, event: 'shutdown_grace_wait' }, 'Waiting for graceful shutdown grace period');
  await new Promise(resolve => setTimeout(resolve, graceMs));
  try { await shutdownWebSocket(wss); } catch (e) { logger.error({ e, event: 'shutdown_ws_error' }, 'WS shutdown error'); }
  try { closeDb(); logger.info({ event: 'db_closed' }, 'SQLite closed'); } catch (e) { logger.error({ e, event: 'db_close_error' }, 'DB close error'); }
  logger.info({ event: 'shutdown_complete' }, 'Shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err, event: 'uncaught_exception' }, 'Uncaught exception');
  gracefulShutdown('uncaughtException').catch(() => process.exit(1));
});
process.on('unhandledRejection', (err) => {
  logger.error({ err, event: 'unhandled_rejection' }, 'Unhandled rejection');
});

export default fastify;
