# Database Architecture & Schema

Coding Orchestrator uses SQLite via `better-sqlite3` as its persistent data store.

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
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') | ISO UTC timestamp. |
| `updated_at` | TEXT | NOT NULL DEFAULT datetime('now') | ISO UTC timestamp. |

### 2. `sessions`

Represents OpenCode interactive session contexts for reuse across tasks.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID identifier. |
| `project_id` | TEXT | REFERENCES `projects(id)` ON DELETE CASCADE | Associated project. |
| `opencode_session_id` | TEXT | NULLABLE | Upstream OpenCode session identifier. |
| `title` | TEXT | NULLABLE | Session title. |
| `model` | TEXT | NULLABLE | Session model override. |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') | ISO UTC timestamp. |
| `updated_at` | TEXT | NOT NULL DEFAULT datetime('now') | ISO UTC timestamp. |

### 3. `tasks`

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
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') | Timestamp created. |
| `started_at` | TEXT | NULLABLE | Timestamp execution began. |
| `finished_at`| TEXT | NULLABLE | Timestamp execution ended. |
| `updated_at` | TEXT | NOT NULL DEFAULT datetime('now') | Last status update. |

### 4. `task_events`

Sequential event stream for real-time WebSocket broadcasting and replay.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Auto-increment ID. |
| `task_id` | TEXT | REFERENCES `tasks(id)` ON DELETE CASCADE | Associated task. |
| `sequence` | INTEGER | NOT NULL | Monotonic sequence per task. |
| `type` | TEXT | NOT NULL | Event classification string. |
| `payload_json` | TEXT | NULLABLE | Serialized event payload. |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') | Timestamp created. |

*Unique constraint*: `UNIQUE(task_id, sequence)`

### 5. `jobs`

High-level multi-agent jobs decomposed into requirements and subtasks.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID identifier. |
| `project_id` | TEXT | REFERENCES `projects(id)` ON DELETE CASCADE | Target project. |
| `prompt` | TEXT | NOT NULL | High-level job plan or specification. |
| `prompt_hash` | TEXT | NOT NULL | SHA-256 hash of the input prompt. |
| `status` | TEXT | CHECK IN ('pending','planning','running','completed','partially_completed','failed','blocked','cancelled','interrupted') | Job lifecycle status. |
| `plan_json` | TEXT | NULLABLE | Extracted requirement graph. |
| `total_requirements` | INTEGER | DEFAULT 0 | Count of requirements. |
| `verified_requirements` | INTEGER | DEFAULT 0 | Count of requirements verified. |
| `completion_percent` | REAL | DEFAULT 0 | Verified requirement ratio. |
| `final_audit_verdict` | TEXT | CHECK IN ('PASS','FAILED','BLOCKED','NOT_TESTED') | Final auditor decision. |
| `report_json` | TEXT | NULLABLE | Comprehensive audit report. |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') | Job creation timestamp. |
| `started_at` | TEXT | NULLABLE | Execution start timestamp. |
| `finished_at`| TEXT | NULLABLE | Execution finish timestamp. |
| `updated_at` | TEXT | NOT NULL DEFAULT datetime('now') | Timestamp updated. |

### 6. `job_requirements`

Individual specification items extracted from the job plan.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID identifier. |
| `job_id` | TEXT | REFERENCES `jobs(id)` ON DELETE CASCADE | Associated job. |
| `requirement_id` | TEXT | NOT NULL | Identifier (e.g. `REQ-001`). |
| `requirement_text` | TEXT | NOT NULL | Requirement description. |
| `section_reference` | TEXT | NULLABLE | Markdown heading or section. |
| `acceptance_criteria_json` | TEXT | DEFAULT '[]' | Acceptance criteria items. |
| `mandatory` | INTEGER | DEFAULT 1 | 1 for mandatory, 0 for optional. |
| `verification_status` | TEXT | CHECK IN ('unverified','verified','failed','blocked','not_tested') | Current verification state. |
| `source_location` | TEXT | NULLABLE | Extracted file or line context. |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') | Timestamp created. |

### 7. `job_subtasks`

Executable work units assigned to agents.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID identifier. |
| `job_id` | TEXT | REFERENCES `jobs(id)` ON DELETE CASCADE | Associated job. |
| `project_id` | TEXT | REFERENCES `projects(id)` ON DELETE CASCADE | Target project. |
| `subtask_id` | TEXT | NOT NULL | Subtask identifier matching requirement. |
| `title` | TEXT | NOT NULL | Title. |
| `description` | TEXT | NULLABLE | Detailed description. |
| `prompt` | TEXT | NOT NULL | Instruction prompt sent to agent. |
| `acceptance_criteria_json` | TEXT | DEFAULT '[]' | Criteria for auditor verification. |
| `model` | TEXT | NULLABLE | Model override. |
| `role` | TEXT | CHECK IN ('worker','auditor','integration','supervisor') | Assigned role. |
| `parent_subtask_id` | TEXT | NULLABLE | Parent subtask dependency. |
| `depends_on_json` | TEXT | DEFAULT '[]' | Array of dependency requirement IDs. |
| `status` | TEXT | CHECK IN (...) | Fine-grained execution state. |
| `priority` | INTEGER | DEFAULT 0 | Scheduling priority. |
| `attempt` | INTEGER | DEFAULT 0 | Current attempt number. |
| `max_attempts` | INTEGER | DEFAULT 2 | Maximum attempts. |
| `worktree_path` | TEXT | NULLABLE | Isolated worktree directory path. |
| `worktree_branch` | TEXT | NULLABLE | Worktree Git branch name. |
| `source_revision` | TEXT | NULLABLE | Git commit hash prior to changes. |
| `open_code_session_id` | TEXT | NULLABLE | OpenCode session identifier. |
| `process_pid` | INTEGER | NULLABLE | OS child process ID. |
| `process_identity` | TEXT | NULLABLE | Compound identity string. |
| `files_changed_json` | TEXT | DEFAULT '[]' | List of modified files. |
| `result_json` | TEXT | NULLABLE | Output summary. |
| `started_at` | TEXT | NULLABLE | Execution start. |
| `finished_at`| TEXT | NULLABLE | Execution end. |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') | Created timestamp. |
| `updated_at` | TEXT | NOT NULL DEFAULT datetime('now') | Updated timestamp. |

### 8. `dependency_edges`

Directed acyclic graph edges linking prerequisite subtasks:
- `id` (PK), `job_id` (FK), `parent_subtask_id` (FK), `child_subtask_id` (FK). `UNIQUE(parent_subtask_id, child_subtask_id)`.

### 9. `agent_executions`

Execution log for all agent processes spawned across all subtask lifecycle stages:
- Records `role` ('supervisor','worker','auditor','integration','repair'), `model`, `status`, `exit_code`, and `result_json`.

### 10. `agent_audits`

Formal audit evaluations generated by the Auditor agent:
- Records `verdict` ('PASS','FAILED','BLOCKED','NOT_TESTED','PENDING','RUNNING'), `criteria_json`, `tests_json`, `evidence_json`, `findings_json`, and `summary`.

### 11. `agent_integration_results`

Records merge operations, conflict detections, and verification results during canonical branch integration.

### 12. `integration_locks`

Guarantees single-writer mutual exclusion during canonical workspace integration:
- `id` (PK), `project_id` (FK, UNIQUE), `owner_process`, `owner_pid`, `acquired_at`, `heartbeat_at`.
