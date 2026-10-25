# Configuration Reference

Coding Orchestrator is configured via environment variables or a local `.env` file loaded at application boot.

## Configuration Options

| Variable | Type | Default | Description |
|---|---|---|---|
| `NODE_ENV` | String | `production` | Node environment (`development`, `production`, `test`). |
| `HOST` | String | `127.0.0.1` | Network interface to bind. Never bind to `0.0.0.0` on untrusted networks without external TLS/auth reverse proxy. |
| `PORT` | Number | `4000` | HTTP and WebSocket listening port. |
| `REQUIRE_AUTH` | Boolean | `true` | When true, rejects requests without valid `ORCHESTRATOR_API_TOKEN`. |
| `ORCHESTRATOR_API_TOKEN` | String | *Empty* | Secret bearer token required for REST and WebSocket authentication. |
| `NINEROUTER_API_KEY` | String | *Empty* | API token passed to OpenCode subprocesses for LLM gateway access. |
| `OPENCODE_BIN` | String | `opencode` | Path to the OpenCode executable binary. |
| `DEFAULT_MODEL` | String | `9router/ayce-combo` | Default LLM model identifier. |
| `MAX_PROMPT_LENGTH` | Number | `10000` | Maximum character length for incoming task prompts. |
| `ORCHESTRATOR_ROOT` | String | `process.cwd()` | Absolute path to the coding orchestrator repository root. |
| `WORKSPACE_ROOT` | String | `~/workspace` | Directory where persistent project repositories are cloned/imported. |
| `DATABASE_PATH` | String | `${ROOT}/data/orchestrator.db` | Absolute path to the SQLite persistence file. |
| `AGENT_WORKTREE_ROOT` | String | `${WORKSPACE_ROOT}/.agent-worktrees` | Root directory for isolated Git agent worktrees. |
| `MAX_CONCURRENT_TASKS` | Number | `2` | Global maximum concurrent single-task executions. |
| `MAX_CONCURRENT_TASKS_PER_PROJECT` | Number | `1` | Maximum concurrent single-task executions per project. |
| `TASK_TIMEOUT_SECONDS` | Number | `3600` | Timeout before an unresponsive task process is terminated. |
| `TASK_KILL_GRACE_SECONDS` | Number | `10` | Grace period in seconds between `SIGTERM` and `SIGKILL` on shutdown/cancellation. |
| `MAX_PARALLEL_WORKERS` | Number | `3` | Maximum concurrent worker agent processes in multi-agent jobs. |
| `MAX_PARALLEL_AUDITORS` | Number | `2` | Maximum concurrent auditor agent processes. |
| `MAX_PARALLEL_INTEGRATIONS`| Number | `1` | Maximum concurrent integration processes. |
| `MAX_GLOBAL_AGENT_PROCESSES`| Number | `5` | Maximum total concurrent agent subprocesses across all jobs. |
| `SUPERVISOR_MODEL` | String | `${DEFAULT_MODEL}` | Model override for the Supervisor planning agent. |
| `WORKER_MODEL` | String | `${DEFAULT_MODEL}` | Model override for the Worker implementation agent. |
| `AUDITOR_MODEL` | String | `${DEFAULT_MODEL}` | Model override for the Auditor verification agent. |
| `INTEGRATION_MODEL` | String | `${DEFAULT_MODEL}` | Model override for the Integration agent. |
| `MAX_AUDIT_RETRIES` | Number | `2` | Maximum retry attempts when an audit fails. |
| `MAX_REPAIR_ATTEMPTS` | Number | `2` | Maximum repair attempts before marking a subtask `blocked`. |
| `LOG_LEVEL` | String | `info` | Logging verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). |
| `LOG_MAX_SIZE` | String | `20M` | Threshold size triggering application log file rotation. |
| `LOG_RETENTION_DAYS` | Number | `7` | Retention threshold in days for archived logs. |
| `LOG_MAX_FILES` | Number | `10` | Maximum number of rotated application log files retained. |
| `TASK_LOG_MAX_SIZE` | String | `20M` | Threshold size for individual task logs. |
| `TASK_LOG_RETENTION_DAYS` | Number | `7` | Retention threshold in days for task execution logs. |
| `TASK_EVENT_RETENTION_DAYS`| Number | `7` | Days to retain terminal task events in SQLite `task_events`. |
| `TASK_EVENT_MAX_BYTES` | Number | `65536` | Maximum byte size before an event payload is truncated in SQLite. |
| `CLEANUP_INTERVAL_HOURS` | Number | `24` | Interval in hours between background database cleanup cycles. |
| `MIN_FREE_DISK_MB` | Number | `2048` | Minimum free disk space in megabytes required to accept new tasks. |
| `MAX_DISK_USAGE_PERCENT` | Number | `90` | Maximum disk percentage capacity allowed before blocking execution. |
| `DISK_CHECK_INTERVAL_SECONDS`| Number | `60` | Frequency of disk status polling. |

## Example `.env` Setup

```bash
cp .env.example .env
chmod 600 .env
```

Ensure `.env` permissions are restricted to the service user (`chmod 600 .env`) and never tracked by Git.
