# REST API Reference

All requests require authentication via the `Authorization: Bearer <ORCHESTRATOR_API_TOKEN>` header unless `REQUIRE_AUTH=false`.

## System Probes

### `GET /health`
Returns service health, process PID, running task counters, and disk metrics. Does not require authentication.

```bash
curl http://127.0.0.1:4000/health
```

### `GET /ready`
Readiness probe verifying SQLite connectivity and disk space availability. Does not require authentication.

```bash
curl http://127.0.0.1:4000/ready
```

---

## Sessions API (`/sessions`)

### `GET /sessions`
Lists interactive sessions. Supports filtering by query parameters.

| Query Param | Type | Description |
|---|---|---|
| `type` | string | Filter by `'standalone'` or `'project'`. |
| `projectId` | string | Filter sessions belonging to a project UUID. |
| `userId` | string | Filter by user identifier. |
| `limit` | integer | Number of items to return (default 50). |
| `offset` | integer | Pagination offset (default 0). |

```bash
# List standalone sessions
curl "http://127.0.0.1:4000/sessions?type=standalone" -H "Authorization: Bearer <TOKEN>"
```

### `POST /sessions`
Creates an interactive session.

```bash
# Create Standalone Session (no workspace or project created)
curl -X POST http://127.0.0.1:4000/sessions \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "General Research Session",
    "model": "9router/ayce-combo",
    "metadata": { "environment": "dev" }
  }'
```

```bash
# Create Project-Linked Session
curl -X POST http://127.0.0.1:4000/sessions \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "2b31f71a-6df6-45ef-b14d-6161882d2bb4",
    "title": "Feature Discussion"
  }'
```

### `GET /sessions/:id`
Retrieves detailed session state, type, runtime path, and parsed metadata.

```bash
curl http://127.0.0.1:4000/sessions/<SESSION_ID> -H "Authorization: Bearer <TOKEN>"
```

### `PATCH /sessions/:id`
Updates title, model, or status (`'created'`, `'active'`, `'idle'`, `'interrupted'`, `'closed'`). Rejects attempts to rebind across workspace boundaries (`projectId` / `session_type` cannot be changed).

```bash
curl -X PATCH http://127.0.0.1:4000/sessions/<SESSION_ID> \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Updated Title", "status": "idle" }'
```

### `DELETE /sessions/:id`
Deletes a session and cascades deletion of all associated messages.

```bash
curl -X DELETE http://127.0.0.1:4000/sessions/<SESSION_ID> -H "Authorization: Bearer <TOKEN>"
```

### `POST /sessions/:id/messages`
Executes an interactive turn with real OpenCode continuation and per-session concurrency mutex lock.

```bash
curl -X POST http://127.0.0.1:4000/sessions/<SESSION_ID>/messages \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Explain the project architecture and summarize key points."
  }'
```

**Response (200 OK)**:
```json
{
  "sessionId": "a3df8394-6721-40aa-b426-2db05cf32d93",
  "opencodeSessionId": "ses_e889d19cfffeFu3gzCFNMJrwiQ",
  "response": "The project uses Fastify, SQLite WAL, and isolated OpenCode runners...",
  "status": "idle"
}
```

### `GET /sessions/:id/messages`
Retrieves chronological message history for the session.

```bash
curl http://127.0.0.1:4000/sessions/<SESSION_ID>/messages -H "Authorization: Bearer <TOKEN>"
```

---

## Projects API (`/projects`)

### `GET /projects`
Lists registered projects. Defaults to operational projects (`is_test = 0`).

```bash
# Operational projects
curl http://127.0.0.1:4000/projects -H "Authorization: Bearer <TOKEN>"

# Include test projects
curl "http://127.0.0.1:4000/projects?includeTest=true" -H "Authorization: Bearer <TOKEN>"
```

### `POST /projects`
Creates a project workspace directory under `WORKSPACE_ROOT`.

```bash
curl -X POST http://127.0.0.1:4000/projects \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Backend Service",
    "slug": "backend-service",
    "defaultModel": "9router/ayce-combo",
    "isTest": false
  }'
```

### `POST /projects/:id/sessions`
Creates an interactive session scoped to the project's workspace.

```bash
curl -X POST http://127.0.0.1:4000/projects/<PROJECT_ID>/sessions \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Refactoring Session" }'
```

### `GET /projects/:id/sessions`
Lists all sessions scoped to the specified project.

```bash
curl http://127.0.0.1:4000/projects/<PROJECT_ID>/sessions -H "Authorization: Bearer <TOKEN>"
```

---

## Tasks API (`/tasks`)

### `POST /projects/:id/tasks`
Enqueues a single coding execution task in the project workspace.

```bash
curl -X POST http://127.0.0.1:4000/projects/<PROJECT_ID>/tasks \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Fix unit test failures in tests/auth.test.js",
    "model": "9router/ayce-combo"
  }'
```

### `GET /tasks/:id`
Retrieves task execution state and exit status.

```bash
curl http://127.0.0.1:4000/tasks/<TASK_ID> -H "Authorization: Bearer <TOKEN>"
```

### `POST /tasks/:id/cancel`
Cancels an active or queued task.

```bash
curl -X POST http://127.0.0.1:4000/tasks/<TASK_ID>/cancel -H "Authorization: Bearer <TOKEN>"
```
