import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_LEVEL, LOG_MAX_SIZE, LOG_MAX_FILES, ORCHESTRATOR_ROOT } from './config.js';

const logsDir = join(ORCHESTRATOR_ROOT, 'logs');
const taskLogsDir = join(logsDir, 'tasks');
mkdirSync(logsDir, { recursive: true });
mkdirSync(taskLogsDir, { recursive: true });

const rfs = await import('rotating-file-stream');

const logStream = rfs.createStream('application.log', {
  path: logsDir,
  size: LOG_MAX_SIZE,
  interval: '1d',
  compress: 'gzip',
  maxFiles: LOG_MAX_FILES
});

logStream.on('error', (err) => {
  process.stderr.write(`[logger-file-error] ${err.message}\n`);
});

export const logger = pino({
  level: LOG_LEVEL,
  base: {
    service: 'coding-orchestrator',
    pid: process.pid
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err
  },
  redact: {
    paths: [
      'token', '*.token',
      'password', '*.password',
      'apiKey', '*.apiKey',
      'api_key', '*.api_key',
      'secret', '*.secret',
      'authorization', '*.authorization',
      'req.headers.authorization',
      'headers.authorization',
      'res.headers.authorization',
      'req.headers["x-api-key"]',
      'headers["x-api-key"]'
    ],
    censor: '[REDACTED]'
  }
}, pino.multistream([
  { stream: process.stdout },
  { stream: logStream }
]));

export const flushLogger = async () => {
  return new Promise((resolve) => {
    let pending = 2;
    const done = () => {
      pending--;
      if (pending <= 0) resolve();
    };
    if (typeof logger.flush === 'function') {
      logger.flush(() => done());
    } else {
      done();
    }
    if (logStream && typeof logStream.end === 'function') {
      logStream.end(() => done());
    } else {
      done();
    }
  });
};

export default logger;
