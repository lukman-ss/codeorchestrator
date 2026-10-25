# Operations Guide

This guide provides operational procedures for maintaining, monitoring, and inspecting Coding Orchestrator in production.

## Service Management

```bash
# Check service status
systemctl --user status coding-orchestrator

# View live systemd logs
journalctl --user -u coding-orchestrator -f

# Restart the service
systemctl --user restart coding-orchestrator

# Stop the service gracefully
systemctl --user stop coding-orchestrator
```

During graceful stop, the service finishes or terminates active child processes within `TASK_KILL_GRACE_SECONDS`, flushes the database WAL checkpoint, and closes open WebSocket connections.

---

## Log Inspection

### 1. Active Application Logs
```bash
tail -f logs/application.log
```

Format logs into human-readable text using `pino-pretty` (if installed):
```bash
tail -f logs/application.log | npx pino-pretty
```

### 2. Task Execution Logs
Inspect the stdout/stderr emitted by an individual task process:
```bash
cat logs/tasks/<TASK_ID>.log
```

---

## SQLite Database Inspection

Inspect database status using the `sqlite3` CLI:

```bash
# Connect to SQLite database in read-only mode
sqlite3 file:data/orchestrator.db?mode=ro
```

### Useful Operational Queries:

```sql
-- View queue summary
SELECT status, count(*) FROM tasks GROUP BY status;

-- View currently running tasks and PIDs
SELECT id, project_id, status, pid, started_at FROM tasks WHERE status = 'running';

-- Inspect multi-agent job completion rates
SELECT id, status, total_requirements, verified_requirements, completion_percent, final_audit_verdict FROM jobs ORDER BY created_at DESC LIMIT 5;

-- Check for active integration locks
SELECT * FROM integration_locks;

-- Review recent audit failures
SELECT subtask_id, verdict, findings_json, summary FROM agent_audits WHERE verdict = 'FAILED' ORDER BY created_at DESC LIMIT 5;
```

---

## Storage & Capacity Maintenance

### Disk Free Verification
The orchestrator checks disk space automatically:
```bash
curl -s -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:4000/health | jq '{diskFreeMB, diskUsagePercent}'
```

### Clearing Orphaned Integration Locks
If a server crash occurs during an integration merge and leaves a dangling lock:
```bash
sqlite3 data/orchestrator.db "DELETE FROM integration_locks WHERE acquired_at < datetime('now', '-1 hour');"
```

### Forcing WAL Checkpointing
```bash
sqlite3 data/orchestrator.db "PRAGMA wal_checkpoint(TRUNCATE);"
```
