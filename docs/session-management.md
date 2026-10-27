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

### Large Specification Streaming (stdin)

Standard Linux kernels impose a strict `MAX_ARG_STRLEN` limit (128KB) on single command-line arguments. Prompts approaching or exceeding this limit fail with `E2BIG (Argument list too long)`.

To support specifications up to 1,000,000 characters:
- Prompts <= 32KB (`32,768` bytes) are passed as CLI arguments to `opencode run <prompt>`.
- Prompts > 32KB are piped directly to OpenCode process `stdin` with stream termination (`child.stdin.end()`), avoiding CLI argument limits completely.
- Prompt artifacts are saved to `data/prompt-artifacts/` with `0600` permissions (directory `0700`) and tracked with SHA-256 integrity digests.

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

## 6. Natural Chat & Discord Conversation Mapping

In the Discord Bridge integration (`bridge.db`), natural chat interactions map directly into real OpenCode sessions:

1. **Conversation Scoping (`discord_conversations`)**:
   - Scoped by `(guild_id, channel_id, thread_id, discord_user_id, status)`.
   - Default: One active standalone session (`project_id = NULL`) per authorized user per channel/thread.
   - User B cannot reply to or continue User A's private standalone session.
2. **Historical Routing (`discord_session_messages`)**:
   - Maps each Discord message ID to its conversation and session ID.
   - Direct replies to older bot messages look up the message's historical `session_id`, allowing users to branch or resume past sessions effortlessly.
3. **Session Lifecycle & Recovery**:
   - On orchestrator boot, `recoverSessions()` resets any sessions left in `'active'` state back to `'idle'`.
   - When closed via `/code session close` or PATCH `/sessions/:id` (`status = 'closed'`), the conversation record is archived (`status = 'closed'`), and the next user mention creates a fresh standalone session.

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
