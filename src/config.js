import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { config } from 'node:process';

const DEFAULT_ROOT = process.cwd();
const DEFAULT_WORKSPACE = process.env.HOME ? resolve(process.env.HOME, 'workspace') : resolve(process.cwd(), 'workspace');

export const NODE_ENV = process.env.NODE_ENV || 'production';
export const PORT = Number(process.env.PORT || 4000);
export const HOST = process.env.HOST || '127.0.0.1';

function resolveOpencodeBin() {
  const custom = process.env.OPENCODE_BIN;
  if (custom && existsSync(custom)) return custom;
  const candidates = [
    custom,
    process.env.HOME ? resolve(process.env.HOME, '.local/npm/bin/opencode') : null,
    process.env.HOME ? resolve(process.env.HOME, '.local/bin/opencode') : null,
    '/usr/local/bin/opencode',
    '/usr/bin/opencode'
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return custom || 'opencode';
}

export const OPENCODE_BIN = resolveOpencodeBin();
export const NINEROUTER_API_KEY = process.env.NINEROUTER_API_KEY || '';
export const ORCHESTRATOR_ROOT = process.env.ORCHESTRATOR_ROOT || DEFAULT_ROOT;
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || DEFAULT_WORKSPACE;
export const SESSION_RUNTIME_ROOT = process.env.SESSION_RUNTIME_ROOT || resolve(ORCHESTRATOR_ROOT, 'data/session-runtime');
export const DATABASE_PATH = process.env.DATABASE_PATH || resolve(ORCHESTRATOR_ROOT, 'data/orchestrator.db');

export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || '9router/ayce-combo';
export const MAX_PROMPT_LENGTH = Math.max(1000000, Number(process.env.MAX_PROMPT_LENGTH || 1000000));

export const API_AUTH_TOKEN = process.env.ORCHESTRATOR_API_TOKEN || '';
export const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== 'false';

export const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS || 2);
export const MAX_CONCURRENT_TASKS_PER_PROJECT = Number(process.env.MAX_CONCURRENT_TASKS_PER_PROJECT || 1);
export const TASK_TIMEOUT_SECONDS = Number(process.env.TASK_TIMEOUT_SECONDS || 3600);
export const TASK_KILL_GRACE_SECONDS = Number(process.env.TASK_KILL_GRACE_SECONDS || 10);

export const MAX_PARALLEL_WORKERS = Number(process.env.MAX_PARALLEL_WORKERS || 3);
export const MAX_PARALLEL_AUDITORS = Number(process.env.MAX_PARALLEL_AUDITORS || 2);
export const MAX_PARALLEL_INTEGRATIONS = Number(process.env.MAX_PARALLEL_INTEGRATIONS || 1);
export const MAX_GLOBAL_AGENT_PROCESSES = Number(process.env.MAX_GLOBAL_AGENT_PROCESSES || 5);

export const AUDIT_MODEL_OVERRIDE = process.env.AUDIT_MODEL || '';
export const INTEGRATION_MODEL_OVERRIDE = process.env.INTEGRATION_MODEL || '';
export const SUPERVISOR_MODEL = process.env.SUPERVISOR_MODEL || DEFAULT_MODEL;
export const WORKER_MODEL = process.env.WORKER_MODEL || DEFAULT_MODEL;
export const AUDITOR_MODEL = process.env.AUDITOR_MODEL || DEFAULT_MODEL;
export const INTEGRATION_MODEL = process.env.INTEGRATION_MODEL || DEFAULT_MODEL;

export const MAX_AUDIT_RETRIES = Number(process.env.MAX_AUDIT_RETRIES || 2);
export const MAX_REPAIR_ATTEMPTS = Number(process.env.MAX_REPAIR_ATTEMPTS || 2);

export const AGENT_WORKTREE_ROOT = process.env.AGENT_WORKTREE_ROOT || `${WORKSPACE_ROOT}/.agent-worktrees`;

export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
export const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE || '20M';
export const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS || 7);
export const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES || 10);

export const TASK_LOG_MAX_SIZE = process.env.TASK_LOG_MAX_SIZE || '20M';
export const TASK_LOG_RETENTION_DAYS = Number(process.env.TASK_LOG_RETENTION_DAYS || 7);

export const TASK_EVENT_RETENTION_DAYS = Number(process.env.TASK_EVENT_RETENTION_DAYS || 7);
export const TASK_EVENT_MAX_BYTES = Number(process.env.TASK_EVENT_MAX_BYTES || 65536);
export const CLEANUP_INTERVAL_HOURS = Number(process.env.CLEANUP_INTERVAL_HOURS || 24);

export const MIN_FREE_DISK_MB = Number(process.env.MIN_FREE_DISK_MB || 2048);
export const MAX_DISK_USAGE_PERCENT = Number(process.env.MAX_DISK_USAGE_PERCENT || 90);
export const DISK_CHECK_INTERVAL_SECONDS = Number(process.env.DISK_CHECK_INTERVAL_SECONDS || 60);
export const DISK_FREE_THRESHOLD_MB = MIN_FREE_DISK_MB;

export const CANCEL_TIMEOUT_MS = TASK_KILL_GRACE_SECONDS * 1000;
