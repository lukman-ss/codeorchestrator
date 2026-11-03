import assert from 'node:assert';
import { logger, flushLogger } from '../src/logger.js';
import { shutdownWebSocket } from '../src/realtime/websocket.js';
import { shutdownAll } from '../src/services/task-queue.js';
import { shutdownAllAgents } from '../src/services/agent-execution-engine.js';
import { shutdownAllSessions } from '../src/services/session-service.js';
import { recoverJobs } from '../src/services/job-service.js';

// ponytail: basic assert test for logger redaction & shutdown lifecycle without mocking frameworks
const testLoggerRedactionAndErrors = async () => {
  const captured = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    captured.push(chunk.toString());
    return true;
  };

  try {
    const err = new Error('Database connection failed');
    logger.error({ err, apiKey: 'secret-12345', token: 'bearer-xyz' }, 'Operation failed test');
    await flushLogger();
  } finally {
    process.stdout.write = origWrite;
  }

  const logLine = captured.find(line => line.includes('Operation failed test'));
  assert(logLine, 'Log line should be captured');
  const parsed = JSON.parse(logLine);

  assert.strictEqual(parsed.apiKey, '[REDACTED]', 'apiKey must be redacted');
  assert.strictEqual(parsed.token, '[REDACTED]', 'token must be redacted');
  assert(parsed.err && parsed.err.message === 'Database connection failed', 'err.message must not be redacted');
  assert(parsed.err.stack, 'err.stack must be preserved');
};

const testShutdownFunctions = async () => {
  assert(typeof shutdownWebSocket === 'function', 'shutdownWebSocket should be function');
  assert(typeof shutdownAll === 'function', 'shutdownAll should be function');
  assert(typeof shutdownAllAgents === 'function', 'shutdownAllAgents should be function');
  assert(typeof shutdownAllSessions === 'function', 'shutdownAllSessions should be function');
  assert(typeof recoverJobs === 'function', 'recoverJobs should be function');

  // Should resolve gracefully when empty
  await shutdownWebSocket(null);
  await shutdownAll(100);
  await shutdownAllAgents(100);
  await shutdownAllSessions(100);
};

await testLoggerRedactionAndErrors();
await testShutdownFunctions();
console.log('OK: lifecycle and logging tests passed');
