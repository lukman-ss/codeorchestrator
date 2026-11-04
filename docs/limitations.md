# Known Limitations & Constraints

This document details current architectural, runtime, and operational boundaries of Coding Orchestrator.

## Architectural Boundaries

- **Single-Node Execution**: Orchestrator runs as a single Node.js instance. It does not support multi-node clustering or distributed task coordination.
- **SQLite Concurrency**: SQLite operates in WAL mode with a busy timeout (`5000ms`). High-concurrency writes may face transaction queueing.
- **Filesystem Locality**: Workspaces must reside on a filesystem directly accessible to the orchestrator host. Network mounts (NFS/SMB) must support POSIX file locking.
- **No In-Database File Storage (No BLOBs)**: SQLite exclusively stores operational metadata and JSON payloads. Working trees, files, and Git revisions exist purely on the filesystem. Large prompt artifacts are written to `data/prompt-artifacts/`.
- **No Task Staging / Draft Lifecycle**: Tasks lack an internal draft/staging state machine. Submitting a task immediately enqueues it. Pre-flight staging or iterative draft compilation must occur externally.
- **Single-Repository Workspace Authority**: The execution plane operates on exactly one canonical repository workspace per task. Cross-repository atomic commits or multi-repo worktrees are not supported; `ProjectContextResolver` halts cross-repo scope conflicts (`SCOPE_CONFLICT`).
- **Subprocess Dependency**: Task execution requires the `opencode` CLI installed on the local system path.
- **WebSocket Streaming**: Real-time events rely solely on WebSockets (`ws://`). No Server-Sent Events (SSE) or long-polling fallbacks are implemented.

## Security & Access Control

- **Static Bearer Token**: Authentication uses a single shared secret (`ORCHESTRATOR_API_TOKEN`). Multi-tenant role-based access control (RBAC) and per-user permissions are not implemented.
- **Workspace Isolation**: Process isolation relies on OS-level execution privileges and Git worktrees. Containerized or sandbox isolation (Docker, Firecracker, gVisor) is not provided out of the box.

## Operational Constraints

- **Event Retention**: Task events are retained in SQLite (`task_events`). Long-running tasks producing tens of thousands of event rows require periodic database vacuuming.
- **Process Cleanup on SIGKILL**: Ungraceful termination (`SIGKILL`) of the orchestrator host leaves child `opencode` processes orphaned until manually reaped.
- **Log Rotation**: Stdout/stderr logging depends on external log managers (`systemd-journald`, `logrotate`). No internal log file rotation is performed.
