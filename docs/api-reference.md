# REST API Reference

All requests require authentication via the `Authorization: Bearer <ORCHESTRATOR_API_TOKEN>` header unless `REQUIRE_AUTH=false`.

## System Probes

### `GET /health`

Returns service health, process PID, running task counters, and disk metrics. Does not require authentication.

```bash
curl http://127.0.0.1:4000/health
```

**Response (200 OK)**:
```json
{
  "status": "ok",
  "pid": 41019,
  "globalRunning": 0,
  "queueDepth": 0,
  "diskFreeMB": 24326,
  "diskUsagePercent": 16,
  "diskThresholdMB": 2048
}
```

### `GET /ready`

Readiness probe verifying SQLite connectivity and disk space availability. Does not require authentication.

```bash
curl http://127.0.0.1:4000/ready
```

**Response (200 OK)**:
```json
{
  "status": "ready"
}
```

---

## Projects API (`/projects`)

### `GET /projects`

Lists all registered projects ordered by creation time descending.

**Response (200 OK)**:
```json
[
  {
    "id": "2b31f71a-6df6-45ef-b14d-6161882d2bb4",
    "name": "Backend Service",
    "slug": "backend-service",
    "workspace_path": "/path/to/workspace/backend-service",
    "repo_url": null,
    "default_model": "9router/ayce-combo",
    "created_at": "2026-10-25 04:00:00",
    "updated_at": "2026-10-25 04:00:00"
  }
]
```

### `POST /projects`

Creates a new project.

**Request Body**:
```json
{
  "name": "Frontend Web App",
  "slug": "frontend-webapp",
  "repoUrl": "https://github.com/example/frontend.git",
  "defaultModel": "9router/ayce-combo"
}
```

**Response (201 Created)**: Returns the created project object.

### `GET /projects/:id`

Retrieves a single project by ID. Returns `404 Not Found` if missing.

### `PATCH /projects/:id`

Updates editable project fields (`name`, `defaultModel`).

**Request Body**:
```json
{
  "name": "New Name",
  "defaultModel": "9router/claude-3-5-sonnet"
}
```

### `POST /projects/import`

Registers an existing directory under `WORKSPACE_ROOT` without cloning.

**Request Body**:
```json
{
  "slug": "existing-directory-name"
}
```

### `GET /projects/:id/tasks`

Lists all tasks belonging to the specified project.

### `POST /projects/:id/tasks`

Submits a single coding task to the execution queue for the project.

**Request Body**:
```json
{
  "prompt": "Create an express HTTP server in index.js with /health endpoint",
  "model": "9router/ayce-combo",
  "sessionId": "optional-uuid"
}
```

**Response (201 Created)**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued"
}
```

*Note*: Returns `507 Insufficient Storage` if disk free space is below `MIN_FREE_DISK_MB`.

### `GET /projects/:id/sessions`

Lists all OpenCode sessions associated with the project.

---

## Tasks API (`/tasks`)

### `GET /tasks`

Lists all tasks across all projects.

### `GET /tasks/:id`

Retrieves details and execution status of a specific task.

**Response (200 OK)**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "project_id": "2b31f71a-6df6-45ef-b14d-6161882d2bb4",
  "session_id": null,
  "prompt": "Create an express HTTP server",
  "model": "9router/ayce-combo",
  "status": "completed",
  "pid": 42010,
  "exit_code": 0,
  "error": null,
  "created_at": "2026-10-25 04:10:00",
  "started_at": "2026-10-25 04:10:01",
  "finished_at": "2026-10-25 04:10:15",
  "updated_at": "2026-10-25 04:10:15"
}
```

### `GET /tasks/:id/events`

Fetches historical task event records for replay.

**Query Parameters**:
- `afterSequence` (integer, optional): Sequence number after which to retrieve events. Defaults to `0`.

**Response (200 OK)**:
```json
[
  {
    "id": 1,
    "task_id": "550e8400-e29b-41d4-a716-446655440000",
    "sequence": 1,
    "type": "task.queued",
    "payload_json": "{}",
    "created_at": "2026-10-25 04:10:00"
  }
]
```

### `POST /tasks/:taskId/cancel`

Cancels a queued or currently executing task. If running, issues `SIGTERM`, waits for grace period, then `SIGKILL`.

**Response (200 OK)**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "cancelled"
}
```

---

## Sessions API (`/sessions`)

### `GET /sessions/:id`

Retrieves session information.

### `PATCH /sessions/:id`

Updates session metadata (`title`, `model`).

### `GET /sessions/:id/tasks`

Retrieves all tasks associated with the session.

---

## Jobs API (`/jobs` & `/subtasks`)

### `POST /jobs`

Creates and schedules a multi-agent job decomposed into requirements and subtasks.

**Request Body**:
```json
{
  "project_id": "2b31f71a-6df6-45ef-b14d-6161882d2bb4",
  "prompt": "# Project Plan\n1. Implement auth middleware with JWT support\n   Acceptance criteria: must validate Bearer token\n2. Add SQLite schema for users table\n   Acceptance criteria: id, email, password_hash columns"
}
```

**Response (201 Created)**:
```json
{
  "id": "job-uuid-1234",
  "subtaskId": "subtask-uuid-5678"
}
```

### `GET /jobs/:id`

Retrieves job progress, verification percentage, and final audit verdict.

### `GET /jobs/:id/subtasks`

Lists all subtasks, dependency edges, status, and assigned roles.

### `GET /jobs/:id/agents`

Returns current agent capacity and active execution slots for the job.

### `GET /jobs/:id/audits`

Returns audit reports and acceptance verdicts for all subtasks in the job.

### `GET /jobs/:id/integrations`

Returns merge verdicts and integration test results for the job.

### `GET /jobs/:id/execution-graph`

Returns the dependency graph and execution timeline.

### `GET /subtasks/:id/audit`

Retrieves detailed audit records, tests executed, and evidence findings for a single subtask.

### `GET /subtasks/:id/executions`

Lists all agent executions (worker, auditor, repair) recorded for the subtask.

### `POST /subtasks/:id/retry`

Schedules an immediate retry execution for a failed subtask.

### `POST /subtasks/:id/reaudit`

Schedules an immediate re-audit verification for a completed subtask implementation.
