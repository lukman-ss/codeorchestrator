# Database Architecture & Schema

Coding Orchestrator uses SQLite via `better-sqlite3` as its persistent operational data store.

## SQLite Configuration & Pragmas

On database initialization (`src/database/db.js`), the following runtime pragmas are applied:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

- **WAL Mode**: Enables non-blocking concurrent reads while writes are active.
- **Foreign Keys**: Enforces relational cascades (`ON DELETE CASCADE`) to prevent dangling task and execution records.
- **Busy Timeout**: Prevents locking collisions under high concurrency.
- **Passive Checkpointing**: The application triggers `PRAGMA wal_checkpoint(PASSIVE)` during maintenance and graceful shutdown.

---

## Schema Versioning & Migrations

Database migrations are tracked via the `schema_version` table:

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);
```

During startup (`init()`), base tables are initialized, and unapplied migrations from `src/database/migrations.js` are executed sequentially within a database transaction.

---

## Implemented Tables

### 1. `projects`

Stores persistent project workspaces and repository settings.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID identifier. |
| `name` | TEXT | NOT NULL | Human-readable project name. |
| `slug` | TEXT | NOT NULL UNIQUE | URL-safe slug regex `^[a-z0-9-]+$`. |
| `workspace_path` | TEXT | NOT NULL UNIQUE | Canonical filesystem path. |
| `repo_url` | TEXT | NULLABLE | Remote Git clone URL. |
| `default_model` | TEXT | DEFAULT '9router/ayce-combo' | Default LLM model identifier. |
| `is_test` | INTEGER | NOT NULL DEFAULT 0 | Provenance marker (1 = test project, 0 = operational). |
| `metadata_json` | TEXT | DEFAULT '{}' | Structured metadata payload. |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | ISO UTC timestamp. |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | ISO UTC timestamp. |

### 2. `sessions`

Represents interactive OpenCode sessions. Supports both **standalone** sessions (`project_id IS NULL`) and **project-linked** sessions (`project_id NOT NULL`).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID identifier. |
| `project_id` | TEXT | REFERENCES `projects(id)` ON DELETE CASCADE | Associated project or NULL for standalone. |
| `opencode_session_id` | TEXT | NULLABLE | Upstream OpenCode session identifier (`ses_*`). |
| `session_type` | TEXT | NOT NULL DEFAULT 'project' CHECK IN ('standalone','project') | Session mode. |
| `title` | TEXT | NULLABLE | Human-readable session title. |
| `model` | TEXT | NULLABLE | Session model override. |
| `status` | TEXT | NOT NULL DEFAULT 'active' CHECK IN ('created','active','idle','interrupted','closed') | Lifecycle status. |
| `user_id` | TEXT | NULLABLE | Owning user ID for authorization. |
| `runtime_path` | TEXT | NULLABLE | Isolated filesystem path for standalone sessions. |
| `metadata_json` | TEXT | NOT NULL DEFAULT '{}' | Metadata JSON object. |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | ISO UTC timestamp. |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | ISO UTC timestamp. |

*Table Constraint*:
```sql
CHECK((session_type = 'standalone' AND project_id IS NULL) OR (session_type = 'project' AND project_id IS NOT NULL))
```

### 3. `session_messages`

Persistent conversation turn history for interactive sessions.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID identifier. |
| `session_id` | TEXT | REFERENCES `sessions(id)` ON DELETE CASCADE | Associated session. |
| `role` | TEXT | NOT NULL CHECK IN ('user','assistant','system') | Message role. |
| `content` | TEXT | NOT NULL | Message text payload. |
| `opencode_session_id` | TEXT | NULLABLE | OpenCode session identifier at turn time. |
| `metadata_json` | TEXT | DEFAULT '{}' | Optional turn metadata. |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | ISO UTC timestamp. |

### 4. `tasks`

Queued and executed individual OpenCode tasks.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID identifier. |
| `project_id` | TEXT | REFERENCES `projects(id)` ON DELETE CASCADE | Associated project. |
| `session_id` | TEXT | REFERENCES `sessions(id)` ON DELETE SET NULL | Associated session. |
| `prompt` | TEXT | NOT NULL | Task instruction prompt. |
| `model` | TEXT | NULLABLE | Model override. |
| `status` | TEXT | CHECK IN ('queued','running','completed','failed','cancelled','interrupted') | Task lifecycle status. |
| `pid` | INTEGER | NULLABLE | OS child process ID. |
| `exit_code` | INTEGER | NULLABLE | Subprocess exit code. |
| `error` | TEXT | NULLABLE | Error message on failure. |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Timestamp created. |
| `started_at` | TEXT | NULLABLE | Timestamp execution began. |
| `finished_at`| TEXT | NULLABLE | Timestamp execution ended. |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Last status update. |

### 5. `task_events`

Sequential event stream for real-time WebSocket broadcasting and replay.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Auto-increment ID. |
| `task_id` | TEXT | REFERENCES `tasks(id)` ON DELETE CASCADE | Associated task. |
| `sequence` | INTEGER | NOT NULL | Monotonic sequence per task. |
| `type` | TEXT | NOT NULL | Event classification string. |
| `payload_json` | TEXT | NULLABLE | Serialized event payload. |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | Timestamp created. |

---

## Discord Bridge Database (`bridge.db`)

The Discord Bridge maintains an independent SQLite database (`bridge.db`) tracking Discord-specific interaction mapping, message deduplication, and conversational scopes:

### 1. `discord_conversations`

Tracks the active conversational context per authorized user and scope (channel or thread):

```sql
CREATE TABLE discord_conversations (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT,
  discord_user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT,
  conversation_type TEXT NOT NULL DEFAULT 'standalone' CHECK(conversation_type IN ('standalone', 'project')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'closed', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 2. `discord_session_messages`

Tracks message deduplication, idempotency, role, and execution lifecycle:

```sql
CREATE TABLE discord_session_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  discord_message_id TEXT NOT NULL UNIQUE,
  referenced_message_id TEXT,
  message_role TEXT NOT NULL CHECK(message_role IN ('user', 'assistant', 'system')),
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('received', 'queued', 'running', 'completed', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## Operational Migration & Maintenance Utilities

1. **`scripts/migrate.js`**:
   - Performs automated backup before migration (`data/backups/orchestrator.db.<timestamp>.bak`).
   - Runs transactional table rebuild of `sessions` with foreign keys temporarily disabled.
   - Verifies SQLite foreign key integrity (`PRAGMA foreign_key_check`) and database health (`PRAGMA integrity_check`).
2. **`scripts/rollback.js`**:
   - Reverts migration safely from pre-migration backup while preserving transaction logs.
3. **`scripts/cleanup-test-data.js`**:
   - Classifies operational vs test records using `is_test` markers and slug naming conventions.
   - Defaults to **dry-run mode** (`--dry-run` or no flags) to list candidate test rows and directories without mutating data.
   - Supports `--mark` to flag historical records as test data (`is_test = 1`) without destructive directory deletion.
