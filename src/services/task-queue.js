import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OPENCODE_BIN, NINEROUTER_API_KEY as API_KEY, WORKSPACE_ROOT, CANCEL_TIMEOUT_MS, MIN_FREE_DISK_MB, MAX_DISK_USAGE_PERCENT } from '../config.js';
import { dbGetOne, dbRun, dbGet } from '../database/db.js';
import { MAX_CONCURRENT_TASKS_PER_PROJECT as MAX_PROJECT_TASKS, MAX_CONCURRENT_TASKS as MAX_GLOBAL_TASKS } from '../config.js';
import { TaskLogger, cleanupTaskLogs } from './task-logger.js';
import { statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import logger from '../logger.js';

const emitter = new EventEmitter();
const processes = new Map();
const buffers = new Map();
const BUFFER_SIZE = 200;
const dispatchQueue = [];

let globalRunning = 0;
let dispatchBlocked = false;

export const blockDispatch = () => {
  dispatchBlocked = true;
  dispatchQueue.length = 0;
};
export const isDispatchBlocked = () => dispatchBlocked;
export const getDispatchQueue = () => dispatchQueue;
export const getGlobalRunning = () => globalRunning;
export const getCleanupTaskLogs = () => cleanupTaskLogs;

const emitPersisted = (taskId, type, data) => {
  const seqRow = dbGetOne('SELECT COALESCE(MAX(sequence),0) AS m FROM task_events WHERE task_id=?', [taskId]);
  const seq = (seqRow || { m: 0 }).m + 1;
  // limit payload size to prevent huge rows
  const payload = JSON.stringify(data);
  if (payload.length > 64000) {
    data = { ...data, _truncated: true, payloadSnippet: payload.substring(0, 1000) };
  }
  dbRun('INSERT INTO task_events (task_id, sequence, type, payload_json) VALUES (?,?,?,?)',
    [taskId, seq, type, JSON.stringify(data)]);
  let buf = buffers.get(taskId);
  if (!buf) { buf = []; buffers.set(taskId, buf); }
  buf.push({ type, taskId, timestamp: new Date().toISOString(), sequence: seq, data });
  if (buf.length > BUFFER_SIZE) buf.shift();
  emitter.emit(taskId, { type, taskId, timestamp: new Date().toISOString(), sequence: seq, data });
};

export const getBuffer = (taskId) => buffers.get(taskId) || [];

export const onEvent = (taskId, cb) => emitter.on(taskId, cb);
export const offEvent = (taskId, cb) => emitter.off(taskId, cb);

export const enqueueTask = (id) => {
  if (dispatchBlocked) return false;
  if (!dispatchQueue.includes(id)) dispatchQueue.push(id);
  schedule();
  return true;
};

const schedule = () => {
  if (dispatchBlocked) return;
  while (dispatchQueue.length > 0 && globalRunning < MAX_GLOBAL_TASKS) {
    let chosen = null;
    for (const id of dispatchQueue) {
      const task = dbGetOne('SELECT * FROM tasks WHERE id=?', [id]);
      if (!task || task.status !== 'queued') continue;
      const runningForProject = (dbGet('SELECT COUNT(*) AS cnt FROM tasks WHERE project_id=? AND status=?', [task.project_id, 'running'])[0] || { cnt: 0 }).cnt;
      if (runningForProject >= MAX_PROJECT_TASKS) continue;
      chosen = task; break;
    }
    if (!chosen) break;
    dispatchQueue.splice(dispatchQueue.indexOf(chosen.id), 1);
    runTask(chosen);
  }
};

const runTask = (task) => {
  const env = { ...process.env, NINEROUTER_API_KEY: API_KEY };
  const args = ['-m', task.model, '--auto', '--pure', 'run', '--format', 'json'];
  
  // If task has an associated session that has an opencode_session_id, pass -s
  if (task.session_id) {
    const sess = dbGetOne('SELECT opencode_session_id FROM sessions WHERE id = ?', [task.session_id]);
    if (sess && sess.opencode_session_id) {
      args.push('-s', sess.opencode_session_id);
    }
  }
  
  args.push(task.prompt);
  logger.info({ taskId: task.id, hasKey: !!API_KEY, args }, 'Spawning OpenCode task');
  
  const workspace = join(WORKSPACE_ROOT, dbGetOne('SELECT slug FROM projects WHERE id=?', [task.project_id]).slug);
  mkdirSync(workspace, { recursive: true });
  const child = spawn(OPENCODE_BIN, args, {
    cwd: workspace,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processes.set(task.id, child);
  globalRunning++;
  const taskLogger = new TaskLogger(task.id);
  dbRun("UPDATE tasks SET status='running', pid=?, started_at=datetime('now'), updated_at=datetime('now') WHERE id=?", [child.pid, task.id]);
  emitPersisted(task.id, 'task.started', { pid: child.pid, args });
  emitPersisted(task.id, 'task.progress', { state: 'spawned' });

  let capturedSession = false;

  child.stdout.on('data', (chunk) => {
    taskLogger.write(chunk);
    emitPersisted(task.id, 'task.log', { stream: 'stdout', data: chunk.toString() });
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      try {
        const obj = JSON.parse(line);
        
        // Capture OpenCode session ID if present
        if (obj.sessionID && !capturedSession) {
          capturedSession = true;
          if (task.session_id) {
            dbRun("UPDATE sessions SET opencode_session_id=?, updated_at=datetime('now') WHERE id=?", [obj.sessionID, task.session_id]);
            emitPersisted(task.id, 'session.created', { sessionId: task.session_id, opencodeSessionId: obj.sessionID });
          }
        }

        // Real OpenCode 1.19.4 event mapping without fabricating
        if (obj.type === 'tool_use' || obj.type === 'tool_call') {
          emitPersisted(task.id, 'task.tool', {
            tool: obj.part?.tool || obj.tool,
            callID: obj.part?.callID || obj.callID,
            state: obj.part?.state || obj.state
          });
        } else if (obj.type === 'step_start') {
          emitPersisted(task.id, 'task.progress', { step: 'step_start', timestamp: obj.timestamp });
        } else if (obj.type === 'step_finish') {
          emitPersisted(task.id, 'task.progress', {
            step: 'step_finish',
            reason: obj.part?.reason,
            tokens: obj.part?.tokens
          });
        } else if (obj.type === 'text') {
          emitPersisted(task.id, 'task.text', {
            text: obj.part?.text || obj.text,
            timestamp: obj.timestamp
          });
        }
      } catch {}
    }
  });
  child.stderr.on('data', (chunk) => {
    taskLogger.write(chunk);
    emitPersisted(task.id, 'task.log', { stream: 'stderr', data: chunk.toString() });
  });
  child.on('error', (err) => {
    taskLogger.end();
    finish(task.id, 'failed', err.message, child.pid, null);
  });
  child.on('exit', (code) => {
    taskLogger.end();
    finish(task.id, code === 0 ? 'completed' : 'failed', code !== 0 ? `Exit code ${code}` : null, child.pid, code);
  });
};

const finish = (id, status, error, pid, code) => {
  processes.delete(id);
  globalRunning--;
  dbRun("UPDATE tasks SET status=?, error=?, exit_code=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?",
    [status, error, code, id]);
  emitPersisted(id, status === 'completed' ? 'task.completed' : 'task.failed', { exitCode: code, error });
  schedule();
};

export const stopDispatch = () => {
  dispatchBlocked = true;
  dispatchQueue.length = 0;
};
export const resumeDispatch = () => {
  dispatchBlocked = false;
  schedule();
};

export const cancelTask = async (id) => {
  const child = processes.get(id);
  if (child) {
    child.kill('SIGTERM');
    setTimeout(() => { if (processes.has(id)) processes.get(id).kill('SIGKILL'); }, CANCEL_TIMEOUT_MS);
    await new Promise((resolve) => {
      const timer = setTimeout(() => { resolve(); }, CANCEL_TIMEOUT_MS);
      child.on('exit', () => { clearTimeout(timer); resolve(); });
      child.on('error', () => { clearTimeout(timer); resolve(); });
    });
  }
  dbRun("UPDATE tasks SET status='cancelled', finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?", [id]);
  emitPersisted(id, 'task.cancelled');
  schedule();
};

export const shutdownAll = () => {
  const graceMs = (Number(process.env.TASK_KILL_GRACE_SECONDS) || 10) * 1000;
  for (const [id, child] of processes) {
    try { child.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    for (const [id, child] of processes) {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {}
      if (processes.has(id)) {
        processes.delete(id);
        try {
          dbRun("UPDATE tasks SET status='interrupted', error='orchestrator shutdown', finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?", [id]);
          emitPersisted(id, 'task.interrupted', { reason: 'orchestrator shutdown' });
        } catch {}
      }
    }
  }, graceMs);
};

export const recoverRunning = () => {
  const rows = dbGet("SELECT t.*, p.slug FROM tasks t JOIN projects p ON t.project_id=p.id WHERE t.status='running'");
  for (const row of rows) {
    dbRun("UPDATE tasks SET status='interrupted', error='server restarted', finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?", [row.id]);
    emitPersisted(row.id, 'task.interrupted', { reason: 'server restarted' });
  }
};

export const startFromQueue = () => { schedule(); };

export const getDiskStats = () => {
  try {
    const lines = execSync('df -m .').toString().trim().split(/\r?\n/);
    if (lines.length >= 2) {
      const parts = lines[1].trim().split(/\s+/);
      const availableMB = parseInt(parts[3], 10);
      const usePercentStr = parts[4].replace('%', '');
      const usePercent = parseInt(usePercentStr, 10);
      return { availableMB, usePercent };
    }
  } catch {}
  return { availableMB: Infinity, usePercent: 0 };
};

export const checkDiskSpace = () => {
  const { availableMB, usePercent } = getDiskStats();
  const okMB = availableMB >= MIN_FREE_DISK_MB;
  const okPercent = usePercent <= MAX_DISK_USAGE_PERCENT;
  return okMB && okPercent;
};
