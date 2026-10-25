# Troubleshooting Guide

This guide provides diagnostic procedures and resolutions for common issues encountered when running Coding Orchestrator.

## Common Issues & Diagnoses

### 1. Service Fails to Start: Missing Auth Token

**Symptoms**:
Service exits immediately on startup with return code 1. Application log displays:
`{"level":60,"event":"missing_auth_token","msg":"ORCHESTRATOR_API_TOKEN must be set when REQUIRE_AUTH is true"}`

**Cause**:
`REQUIRE_AUTH` is enabled (default `true`), but `ORCHESTRATOR_API_TOKEN` is unset or empty in the environment.

**Resolution**:
Define a secure token in `.env`:
```ini
ORCHESTRATOR_API_TOKEN=generate-a-secure-random-token
```
Or for local testing environments without authentication:
```ini
REQUIRE_AUTH=false
```

---

### 2. Task Rejected with HTTP 507 Insufficient Storage

**Symptoms**:
`POST /projects/:id/tasks` returns `507 Insufficient Storage`:
`{"error":"Insufficient disk space to execute new tasks"}`

**Cause**:
Available disk space has dropped below `MIN_FREE_DISK_MB` (default 2048 MB) or disk usage exceeds `MAX_DISK_USAGE_PERCENT` (default 90%).

**Resolution**:
1. Check available disk space: `df -h .`
2. Purge old rotated logs: `rm -f logs/*.log.gz`
3. Prune old workspaces or build artifacts in `workspace/`.
4. Adjust thresholds in `.env` if operating on small development disks:
   ```ini
   MIN_FREE_DISK_MB=1024
   MAX_DISK_USAGE_PERCENT=95
   ```

---

### 3. OpenCode Exits Non-Zero or Fails to Spawn

**Symptoms**:
Task immediately transitions to `failed` with error `OpenCode exited with code 127` or `ENOENT`.

**Cause**:
The `opencode` binary is not in the system `$PATH` or the path configured in `OPENCODE_BIN` is invalid.

**Resolution**:
1. Verify the binary location:
   ```bash
   which opencode
   ```
2. Set the explicit path in `.env`:
   ```ini
   OPENCODE_BIN=/usr/local/bin/opencode
   ```
3. Ensure the service user has execution permissions on the binary.

---

### 4. Model Gateway 401 Unauthorized Error

**Symptoms**:
Task log in `logs/tasks/<id>.log` contains:
`{"name":"APIError","data":{"message":"Unauthorized: API key required for remote API access","statusCode":401}}`

**Cause**:
`NINEROUTER_API_KEY` is missing or invalid in the orchestrator environment.

**Resolution**:
Set `NINEROUTER_API_KEY` in `.env` or export it before starting the service:
```ini
NINEROUTER_API_KEY=your-valid-api-key
```

---

### 5. WebSocket Handshake Fails (401 Unauthorized)

**Symptoms**:
WebSocket connection to `ws://127.0.0.1:4000/ws` is rejected with HTTP 401.

**Cause**:
Missing or mismatched bearer token in handshake headers.

**Resolution**:
Supply the token either via the `Authorization` header or WebSocket subprotocol:
```javascript
const ws = new WebSocket('ws://127.0.0.1:4000/ws', [ORCHESTRATOR_API_TOKEN]);
```

---

### 6. Subtask Blocked Due to Integration Lock

**Symptoms**:
Subtask remains in `integration_pending` and logs report:
`Integration lock already held, skipping integration`

**Cause**:
A previous integration process crashed or terminated before clearing its row in `integration_locks`.

**Resolution**:
Inspect and clear expired locks:
```bash
sqlite3 data/orchestrator.db "SELECT * FROM integration_locks;"
sqlite3 data/orchestrator.db "DELETE FROM integration_locks;"
```
Restart the scheduler by restarting the service.
