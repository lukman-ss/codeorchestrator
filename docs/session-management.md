# Session Management

Coding Orchestrator tracks OpenCode execution sessions to preserve conversational context and tool interaction history.

## OpenCode Session Mapping

When an OpenCode process spawns with `--format json`, it emits structured event lines on `stdout`. The orchestrator inspects incoming chunks for the `sessionID` field:

```json
{"type":"step_finish","timestamp":1792818616314,"sessionID":"ses_e93af0cd8ffeqP5E25Agrc3G8U",...}
```

When discovered, the orchestrator associates the session ID with the running task and execution records:

```sql
UPDATE job_subtasks SET open_code_session_id = ? WHERE id = ?;
UPDATE agent_executions SET session_id = ? WHERE id = ?;
```

---

## Session API Endpoints

### 1. `GET /sessions/:id`
Retrieves stored session metadata, associated project ID, and model configuration.

### 2. `PATCH /sessions/:id`
Updates the human-readable title or default model associated with the session:
```bash
curl -X PATCH http://127.0.0.1:4000/sessions/<SESSION_ID> \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Refactoring Session", "model": "9router/ayce-combo" }'
```

### 3. `GET /sessions/:id/tasks`
Lists all tasks executed within the context of this session.

---

## Implementation Status & Limitations

- **Implemented**: Automatic extraction of `sessionID` from OpenCode stdout streams, persistence in SQLite, session metadata updates, and task-to-session queries.
- **Partially Implemented**: Explicit session continuation via the `--session` CLI flag in OpenCode is supported internally by passing `sessionId` in `POST /projects/:id/tasks`, but automated multi-turn conversation caching across distributed workers is experimental.
