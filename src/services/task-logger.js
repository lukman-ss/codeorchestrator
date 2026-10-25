import { createWriteStream, statSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_LOG_MAX_SIZE, TASK_LOG_RETENTION_DAYS } from '../config.js';
import logger from '../logger.js';

const parseSize = (sz) => {
  if (typeof sz === 'number') return sz;
  const match = sz.match(/^(\d+)([KMG]?)$/i);
  if (!match) return 20 * 1024 * 1024;
  const num = parseInt(match[1], 10);
  const unit = match[2].toUpperCase();
  if (unit === 'K') return num * 1024;
  if (unit === 'M') return num * 1024 * 1024;
  if (unit === 'G') return num * 1024 * 1024 * 1024;
  return num;
};

const MAX_BYTES = parseSize(TASK_LOG_MAX_SIZE);
const TAIL_BUFFER_SIZE = 8192; // 8KB preserved for terminal diagnostics

export class TaskLogger {
  constructor(taskId) {
    this.taskId = taskId;
    this.path = join('./logs/tasks', `${taskId}.log`);
    this.stream = createWriteStream(this.path, { flags: 'a' });
    this.bytesWritten = 0;
    this.truncated = false;
    this.tailBuffer = [];
    this.tailBytes = 0;
  }

  write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    
    // Always maintain tail buffer for terminal diagnostics
    this.tailBuffer.push(buf);
    this.tailBytes += buf.length;
    while (this.tailBytes > TAIL_BUFFER_SIZE && this.tailBuffer.length > 1) {
      const removed = this.tailBuffer.shift();
      this.tailBytes -= removed.length;
    }

    if (this.truncated) {
      return;
    }

    if (this.bytesWritten + buf.length > MAX_BYTES) {
      this.stream.write('\n--- OUTPUT TRUNCATED DUE TO SIZE LIMIT ---\n');
      this.truncated = true;
      logger.warn({ taskId: this.taskId, event: 'task_log_truncated' }, 'Task output truncated');
      return;
    }

    this.stream.write(buf);
    this.bytesWritten += buf.length;
  }

  end() {
    if (this.truncated && this.tailBuffer.length > 0) {
      this.stream.write('\n--- TERMINAL DIAGNOSTICS (LAST 8KB) ---\n');
      for (const b of this.tailBuffer) {
        this.stream.write(b);
      }
    }
    this.stream.end();
  }
}

export const cleanupTaskLogs = () => {
  const dir = './logs/tasks';
  const now = Date.now();
  const maxAgeMs = TASK_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const file of readdirSync(dir)) {
      const p = join(dir, file);
      try {
        const stats = statSync(p);
        if (now - stats.mtimeMs > maxAgeMs) {
          unlinkSync(p);
          logger.info({ file, event: 'task_log_expired' }, 'Deleted expired task log');
        }
      } catch {}
    }
  } catch (err) {
    logger.error({ err, event: 'task_log_cleanup_error' }, 'Error cleaning task logs');
  }
};
