# Session Management

Coding Orchestrator provides two distinct session paradigms:
1. **Standalone Sessions**: Independent OpenCode conversational sessions for general inquiries, architecture advice, brainstorming, and research. They exist without creating a project or workspace directory.
2. **Project Sessions**: Context-bound OpenCode sessions tied directly to a specific workspace and Git repository for targeted code generation and automated task execution.

---

## 1. Core Architectural Differences

| Attribute | Standalone Session | Project-Linked Session |
|---|---|---|
| `session_type` | `'standalone'` | `'project'` |
| `project_id` | `NULL` | Must reference existing `projects(id)` |
| Filesystem Location | Isolated `data/session-runtime/<sessionId>` | Canonical workspace (`WORKSPACE_ROOT/<slug>`) |
| Workspace Generation | **None** (zero pollution in `/workspace`) | Existing workspace directory |
| Upstream OpenCode | `opencode run -m <model> --auto --format json -s <opencodeId>` | Same, executed in project workspace |
| Task Association | Independent conversation history | Can associate with queued tasks |

---

## 2. Database Schema & Constraints

The `sessions` table enforces relational and operational integrity through a strict `CHECK` constraint:

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  opencode_session_id TEXT,
  session_type TEXT NOT NULL DEFAULT 'project' CHECK(session_type IN ('standalone','project')),
  title TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('created','active','idle','interrupted','closed')),
  user_id TEXT,
  runtime_path TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK((session_type = 'standalone' AND project_id IS NULL) OR (session_type = 'project' AND project_id IS NOT NULL))
);
```

### Session Messages Table

Interactive turns are recorded sequentially in `session_messages`:

```sql
CREATE TABLE session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  opencode_session_id TEXT,
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 3. Real OpenCode Session Continuation

When OpenCode spawns with `--format json`, it streams JSON lines over `stdout`. The orchestrator inspects incoming events for the upstream `sessionID`:

```json
{"type":"step_start","timestamp":1793004049748,"sessionID":"ses_e88a172f1ffeRBehik70zNB8xu",...}
{"type":"text","timestamp":1793004049784,"sessionID":"ses_e88a172f1ffeRBehik70zNB8xu","part":{"type":"text","text":"..."}}
```

On initial turn:
1. Orchestrator captures `sessionID` and updates `opencode_session_id` in SQLite.
2. OpenCode assistant response is extracted and persisted as an `'assistant'` role message.

On continuation turn:
1. Orchestrator passes `-s <opencode_session_id>` to `opencode run`.
2. OpenCode loads full conversation context, preserving memory of prior exchanges across commands.

---

## 4. Per-Session Concurrency Control

To prevent race conditions and upstream context corruption caused by concurrent messages to the same OpenCode session, `session-service.js` manages an in-memory sequential lock queue per `sessionId`:

```javascript
// Mutex queue per session
await withSessionLock(sessionId, async () => {
  // Spawns OpenCode, awaits exit code, writes assistant response
});
```

Concurrent requests for the same session wait in sequence; requests for different sessions run in parallel.

---

## 5. Security & Boundary Invariants

1. **Workspace Boundary Protection**: Once created, a session cannot be patched to alter `projectId` or `session_type`. Attempting to convert a standalone session into a project session (or vice-versa) is rejected with an HTTP 400 error.
2. **Access Control**: Sessions with a `user_id` restrict message execution to the owning user or authorized administrative roles.
3. **Closed Session Protection**: Once a session status is set to `'closed'`, subsequent message executions are rejected with HTTP 409 Conflict.

---

## 6. REST API Endpoints

### Create Standalone Session
```http
POST /sessions
Content-Type: application/json
Authorization: Bearer <TOKEN>

{
  "title": "General Research Session",
  "model": "9router/ayce-combo",
  "metadata": { "origin": "api" }
}
```

### Create Project-Linked Session
```http
POST /projects/:id/sessions
Content-Type: application/json
Authorization: Bearer <TOKEN>

{
  "title": "Refactoring Session",
  "model": "9router/ayce-combo"
}
```

### Send Message / Continue Conversation
```http
POST /sessions/:id/messages
Content-Type: application/json
Authorization: Bearer <TOKEN>

{
  "prompt": "What were the key takeaways from our previous turn?"
}
```

### List Session History
```http
GET /sessions/:id/messages
Authorization: Bearer <TOKEN>
```
