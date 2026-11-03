import Fastify from 'fastify';
import { PORT, HOST, API_AUTH_TOKEN, DATABASE_PATH, DISK_FREE_THRESHOLD_MB, REQUIRE_AUTH } from './config.js';
import { init as initDb, close as closeDb } from './database/db.js';
import { recoverOperations } from './services/project-operations.js';
import { recoverSessions, shutdownAllSessions } from './services/session-service.js';
import { recoverRunning, startFromQueue, getGlobalRunning, getDiskStats, shutdownAll, checkDiskSpace, getDispatchQueue, blockDispatch } from './services/task-queue.js';
import { recoverJobs } from './services/job-service.js';
import { shutdownAllAgents } from './services/agent-execution-engine.js';
import { cleanupTaskLogs } from './services/task-logger.js';
import { scheduleCleanup } from './services/maintenance.js';
import projects from './routes/projects.js';
import tasks from './routes/tasks.js';
import sessions from './routes/sessions.js';
import jobs from './routes/jobs.js';
import approvals from './routes/approvals.js';
import dashboardRoutes from './routes/dashboard.js';
import { setupWebSocket, shutdownWebSocket } from './realtime/websocket.js';
import { registerJobRoutes } from './routes/job-routes.js';
import { WorkflowService } from './services/workflow-service.js';
import { ModelRouter } from './services/model-router.js';
import logger, { flushLogger } from './logger.js';

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
  if (REQUIRE_AUTH && API_AUTH_TOKEN &&
      !request.url.startsWith('/health') &&
      !request.url.startsWith('/ready') &&
      !request.url.startsWith('/metrics') &&
      !request.url.startsWith('/dashboard')) {
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
fastify.register(dashboardRoutes);
registerJobRoutes(fastify);

const server = fastify.server;
const wss = setupWebSocket(server);

initDb();
ModelRouter.initDefaultPolicies();
recoverOperations();
recoverSessions();
recoverRunning();
recoverJobs();
WorkflowService.recoverPendingWorkflows();
scheduleCleanup();
setInterval(cleanupTaskLogs, 24 * 3600 * 1000).unref();
startFromQueue();

fastify.listen({ port: PORT, host: HOST }).then(() => {
  logger.info({ event: 'server_started', port: PORT, host: HOST, db: DATABASE_PATH, pid: process.pid }, 'Server ready');
});

let isShuttingDown = false;
const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ event: 'shutdown_signal_received', signal, pid: process.pid }, 'Shutting down gracefully');
  blockDispatch();

  try {
    await shutdownWebSocket(wss);
  } catch (err) {
    logger.error({ err, event: 'shutdown_ws_error' }, 'WS shutdown error');
  }

  try {
    await fastify.close();
    logger.info({ event: 'http_closed' }, 'HTTP server closed');
  } catch (err) {
    logger.error({ err, event: 'shutdown_http_error' }, 'Error closing HTTP server');
  }

  try {
    await Promise.allSettled([
      shutdownAll(),
      shutdownAllAgents(),
      shutdownAllSessions()
    ]);
    logger.info({ event: 'subprocesses_closed' }, 'All subprocesses stopped');
  } catch (err) {
    logger.error({ err, event: 'shutdown_processes_error' }, 'Error shutting down processes');
  }

  try {
    closeDb();
    logger.info({ event: 'db_closed' }, 'SQLite closed');
  } catch (err) {
    logger.error({ err, event: 'db_close_error' }, 'DB close error');
  }

  logger.info({ event: 'shutdown_complete' }, 'Shutdown complete');
  await flushLogger();
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
