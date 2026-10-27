# Coding Orchestrator

A lightweight, robust Node.js orchestration service providing REST and WebSocket APIs to manage persistent coding projects, coordinate standalone and project-linked sessions, and execute OpenCode tasks with concurrency management, event replay, and automated multi-agent verification.

## Features

- **Fastify REST API**: Comprehensive endpoints for workspaces, standalone sessions, project-linked sessions, interactive message continuation, task queues, and event streams.
- **Architectural Separation**: Clean separation between **Projects** (persistent git workspaces in `WORKSPACE_ROOT`) and **Standalone Sessions** (independent OpenCode conversational sessions in `data/session-runtime/<sessionId>` with `project_id = NULL`).
- **Real OpenCode Continuation**: Full multi-turn context persistence leveraging upstream OpenCode CLI session flags (`-s <sessionID>`) with per-session concurrency mutex locks.
- **WebSocket Streaming**: Real-time event streaming (`/ws`) with sequence-based buffer replay.
- **SQLite Persistence**: Embedded ACID persistence with WAL mode, foreign keys, and strict relational `CHECK` constraints.
- **Concurrency Queuing**: Configurable global and per-project task concurrency limits.
- **Discord Bot Bridge**: Production bridge under `/code` featuring Hermes-like automatic channel discovery, originating-channel notification routing, and safe message chunking/redaction.
- **Automated Security Gates**: Built-in secret scanning and release validation checks.

## Architecture

```
                    +---------------------------+
                    |  HTTP Client / WebSocket  |
                    +-------------+-------------+
                                  |
                                  v
                    +---------------------------+
                    | Fastify & ws Server (:4000)|
                    +-------------+-------------+
                                  |
             +--------------------+--------------------+
             |                    |                    |
             v                    v                    v
     +---------------+    +---------------+    +---------------+
     | ProjectService|    | SessionService|    |  TaskQueue    |
     +-------+-------+    +-------+-------+    +-------+-------+
             |                    |                    |
             |       +------------+------------+       |
             |       |                         |       |
             v       v                         v       v
      +-------------+-------------+      +---------------+
      |  Workspace  |   Runtime   |      |  TaskService  |
      |   Storage   |   Storage   |      +-------+-------+
      | (Projects)  |(Standalone) |              |
      +-------------+-------------+              v
                     |                   +---------------+
                     v                   | opencode CLI  |
              +---------------+          +---------------+
              | SQLite (WAL)  |
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
| `PORT` | `4000` | HTTP/WS listening port |
| `HOST` | `127.0.0.1` | Network bind address |
| `WORKSPACE_ROOT` | `~/workspace` | Directory for persistent project codebases |
| `SESSION_RUNTIME_ROOT`| `./data/session-runtime` | Directory for standalone session execution |
| `DATABASE_PATH` | `./data/orchestrator.db` | SQLite database file location |
| `MAX_CONCURRENT_TASKS` | `2` | Global concurrent task execution limit |
| `MAX_CONCURRENT_TASKS_PER_PROJECT` | `1` | Per-project concurrent task execution limit |
| `ORCHESTRATOR_API_TOKEN` | *None* | Bearer token for API authentication |

See [Configuration Guide](docs/configuration.md) for all options.

## API & WebSocket Summary

- **Health Probes**: `GET /health`, `GET /ready`
- **Sessions**:
  - `POST /sessions`: Create standalone session (`project_id = NULL`) or project session
  - `GET /sessions`: List sessions (supports `?type=standalone`, `?projectId=<id>`, `?userId=<id>`)
  - `GET /sessions/:id`: Retrieve session details
  - `PATCH /sessions/:id`: Update title, model, or status
  - `DELETE /sessions/:id`: Remove session and cascade messages
  - `POST /sessions/:id/messages`: Execute interactive message with real OpenCode continuation
  - `GET /sessions/:id/messages`: View message history
- **Projects**:
  - `POST /projects`: Create project workspace (`isTest: true` for test isolation)
  - `GET /projects`: List production projects (`?includeTest=true` to include test projects)
  - `GET /projects/:id`: Get project details
  - `PATCH /projects/:id`: Update project settings
  - `POST /projects/import`: Register existing workspace directory
  - `POST /projects/:id/sessions`: Create session scoped to project workspace
  - `GET /projects/:id/sessions`: List sessions for project
- **Tasks**: `POST /projects/:id/tasks`, `GET /tasks`, `GET /tasks/:id`, `POST /tasks/:id/cancel`
- **WebSocket**: Connect to `ws://HOST:PORT/ws` and subscribe with `{ "type": "subscribe", "taskId": "<id>" }`

## Discord Bot Integration

CodeOrchestrator includes an isolated Discord Bridge (`integrations/discord/`) implementing natural chat conversations and slash commands under `/code`:

- **Natural Chat Interaction**:
  - Mention `@Agent Coding <prompt>` in any authorized channel to start or continue an active standalone session.
  - Reply directly to any bot message to continue that specific conversation branch (routes back to the exact historical OpenCode session).
  - One active standalone session per user per channel/thread; cross-user isolation prevents hijacking.
  - Automatic multi-chunk handling: splits messages <= 1,900 chars; attaches sanitized `.txt` file when response exceeds 3 chunks.
  - Graceful fallback on `GatewayIntentBits.MessageContent` if privileged intent is pending in Discord Developer Portal.
- **Slash Commands**:
  - `/code session new title:<text> [project:<name>] [model:<model>]`: Explicitly create a standalone or project-linked session
  - `/code session info [session:<id>]`: View session metadata, turn count, and token usage
  - `/code session close [session:<id>]`: Archive active conversation without deleting history
  - `/code chat prompt:<text> [session:<id>] [model:<model>]`: Start or continue a conversation
  - `/code resume session:<id> prompt:<text>`: Send follow-up prompt to an existing OpenCode session
  - `/code sessions [project:<name>] [page:<num>]`: List authorized standalone and project sessions
  - `/code project create`: Create a persistent project workspace via an interactive modal form and confirmation card
  - `/code project import`: Register an unmanaged directory under workspace root with stack detection
  - `/code project info`: Inspect project details, git remote, default branch, model, and active sessions
  - `/code projects`: View accessible persistent coding workspaces with relative slugs and Git status
  - `/code run`: Submit single coding tasks to a project workspace
  - `/code job`: Submit multi-agent workflows with automated worker, auditor, and integration roles
  - `/code status`: Real-time task, job, or session status inspection
  - `/code audit`: Independent auditor findings and verification evidence
  - `/code report`: Final execution summaries
  - `/code cancel`: Idempotent task/job cancellation with explicit confirmation
  - `/code help`: Command usage summary

For full documentation and systemd setup, see [Discord Integration Guide](docs/discord-integration.md).

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

All automated tests use isolated temporary databases and dynamic ports to prevent test pollution in the operational SQLite database (`data/orchestrator.db`).

Run all test suites:
```bash
npm test
```

Run pre-commit security and credential audit:
```bash
./scripts/security-check.sh
```
