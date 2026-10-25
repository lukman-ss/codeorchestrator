# Coding Orchestrator

A lightweight, robust Node.js orchestration service providing REST and WebSocket APIs to manage persistent coding projects, coordinate sessions, and execute OpenCode tasks with concurrency management and event replay.

## Features

- **Fastify REST API**: Endpoints for projects, sessions, tasks, event logs, and system probes.
- **WebSocket Streaming**: Real-time event streaming (`/ws`) with sequence-based buffer replay.
- **SQLite Persistence**: Embedded persistence for projects, sessions, tasks, and task event journals.
- **Concurrency Queuing**: Configurable global and per-project task concurrency limits.
- **Process Isolation**: Spawns isolated OpenCode child processes with stdout/stderr JSON event parsing.
- **Automated Security Gates**: Built-in secret scanning and release validation checks.

## Architecture

```
                    +---------------------------+
                    |  HTTP Client / WebSocket  |
                    +-------------+-------------+
                                  |
                                  v
                    +---------------------------+
                    | Fastify & ws Server (:3000)|
                    +-------------+-------------+
                                  |
             +--------------------+--------------------+
             |                    |                    |
             v                    v                    v
     +---------------+    +---------------+    +---------------+
     | ProjectService|    | SessionService|    |  TaskQueue    |
     +-------+-------+    +-------+-------+    +-------+-------+
             |                    |                    |
             +--------------------+                    v
                                  |            +---------------+
                                  v            |  TaskService  |
                          +---------------+    +-------+-------+
                          | SQLite (WAL)  |            |
                          +---------------+            v
                                               +---------------+
                                               | opencode CLI  |
                                               +---------------+
```

For complete architecture details, see [Architecture](docs/architecture.md).

## Quick Start

### Prerequisites

- Node.js 24+
- OpenCode CLI installed and available in `$PATH`
- Git 2.30+

### Installation & Run

1. Clone and install dependencies:
   ```bash
   git clone <repository-url>
   cd coding-orchestrator
   npm install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   ```

3. Start server:
   ```bash
   npm start
   ```

For detailed guides, see [Getting Started](docs/getting-started.md) and [Installation](docs/installation.md).

## Configuration

Core settings configured via environment variables:

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT` | `3000` | HTTP/WS listening port |
| `HOST` | `127.0.0.1` | Network bind address |
| `WORKSPACE_BASE` | `./workspaces` | Base directory for project workspaces |
| `DB_PATH` | `./data/orchestrator.db` | SQLite database file location |
| `MAX_CONCURRENT_TASKS` | `2` | Global concurrent task execution limit |
| `MAX_TASKS_PER_PROJECT` | `1` | Per-project concurrent task execution limit |
| `ORCHESTRATOR_API_TOKEN` | *None* | Bearer token for API authentication |

See [Configuration Guide](docs/configuration.md) for all options.

## API & WebSocket Summary

- **Health Checks**: `GET /health`, `GET /ready`
- **Projects**: `POST /projects`, `GET /projects`, `GET /projects/:id`, `PATCH /projects/:id`, `POST /projects/import`
- **Sessions**: `POST /sessions/:projectId`, `GET /sessions/:id`, `PATCH /sessions/:id`
- **Tasks**: `POST /projects/:projectId/tasks`, `GET /tasks`, `GET /tasks/:id`, `POST /tasks/:id/cancel`
- **WebSocket**: Connect to `ws://HOST:PORT/ws` and subscribe with `{ "type": "subscribe", "taskId": "<id>" }`

## Discord Bot Integration

CodeOrchestrator includes an isolated Discord Bridge (`integrations/discord/`) implementing slash commands under `/code`:

- `/code projects`: View accessible projects
- `/code run`: Submit single coding tasks
- `/code job`: Submit multi-agent workflows with automated worker, auditor, and integration roles
- `/code status`: Real-time status inspection
- `/code audit`: Independent auditor findings and verification evidence
- `/code report`: Final execution summaries
- `/code cancel`: Idempotent task/job cancellation with explicit confirmation

For full documentation and systemd setup, see [Discord Integration Guide](docs/discord-integration.md).

Refer to:
- [API Reference](docs/api-reference.md)
- [WebSocket Protocol](docs/websocket.md)
- [Task Lifecycle](docs/task-lifecycle.md)

## Documentation Index

- **Core Concepts**:
  - [Project Management](docs/project-management.md)
  - [Session Management](docs/session-management.md)
  - [Database Schema](docs/database.md)
  - [Multi-Agent System](docs/multi-agent.md)
  - [Agent Roles](docs/agent-roles.md)
- **Operations & Security**:
  - [Task Scheduler](docs/scheduler.md)
  - [Audit & Verification](docs/audit-and-verification.md)
  - [Git Worktree Isolation](docs/git-worktree-isolation.md)
  - [Logging & Retention](docs/logging-and-retention.md)
  - [Security Architecture](docs/security.md)
  - [Production Deployment](docs/deployment.md)
  - [Operations Runbook](docs/operations.md)
  - [Troubleshooting](docs/troubleshooting.md)
  - [Known Limitations](docs/limitations.md)

## Testing & Validation

Run unit and integration tests:
```bash
npm test
```

Run pre-commit security audit:
```bash
./scripts/security-check.sh
```

Run complete public release validation gate:
```bash
./scripts/public-release-check.sh
```

See [Testing Guide](docs/testing.md) for test execution details.

## Contributing

Review [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before submitting pull requests.

## License

See [LICENSE](LICENSE).
