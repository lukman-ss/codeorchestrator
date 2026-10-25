import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_LEVEL, LOG_MAX_SIZE, LOG_MAX_FILES, ORCHESTRATOR_ROOT } from './config.js';

mkdirSync('./logs', { recursive: true });
mkdirSync('./logs/tasks', { recursive: true });

const rfs = await import('rotating-file-stream');

const logStream = rfs.createStream('application.log', {
  path: join(ORCHESTRATOR_ROOT, 'logs'),
  size: LOG_MAX_SIZE,
  interval: '1d',
  compress: 'gzip',
  maxFiles: LOG_MAX_FILES
});

export const logger = pino({
  level: LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.body.prompt', 'headers.authorization', 'res.headers.authorization', 'error', 'err', 'message'],
  base: { service: 'coding-orchestrator' },
  timestamp: pino.stdTimeFunctions.isoTime
}, logStream);

export default logger;
