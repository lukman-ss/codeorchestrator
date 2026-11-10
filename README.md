# Coding Orchestrator

A lightweight, robust Node.js orchestration service providing REST and WebSocket APIs to manage persistent coding projects, coordinate standalone and project-linked sessions, and execute OpenCode tasks with concurrency management, event replay, and automated multi-agent verification.

## Features

- **Fastify REST API**: Comprehensive endpoints for workspaces, standalone sessions, project-linked sessions, interactive message continuation, task queues, project validation/repair, and event streams.
- **Architectural Separation**: Clean separation between **Projects** (persistent git workspaces in `WORKSPACE_ROOT`) and **Standalone Sessions** (independent OpenCode conversational sessions in `data/session-runtime/<sessionId>` with `project_id = NULL`).
- **Real OpenCode Continuation**: Full multi-turn context persistence leveraging upstream OpenCode CLI session flags (`-s <sessionID>`) with per-session concurrency mutex locks. Automatic stdin streaming for prompts > 32KB avoids Linux `MAX_ARG_STRLEN` (128KB) limits.
- **Workspace Protection & Repair**: Automated git remote mismatch detection blocks executions when project workspaces point to unexpected repositories (including critical `ballo` workspace guards), paired with safe metadata repair APIs.
- **WebSocket Streaming**: Real-time event streaming (`/ws`) with sequence-based buffer replay.
- **SQLite Persistence**: Embedded ACID persistence with WAL mode, foreign keys, and strict relational `CHECK` constraints.
- **Concurrency Queuing**: Configurable global and per-project task concurrency limits.
- **Discord Bot Bridge**: Production bridge under `/code` featuring Hermes-like automatic channel discovery, originating-channel notification routing, and safe message chunking/redaction.
- **Three Mandatory Completion Gates**: Full verification pipeline across tasks and multi-agent jobs before completion:
  - **Gate 1 (Implementation Verification)**: Automated stack detection, syntax lint/checks, and test execution against acceptance criteria.
  - **Gate 2 (Independent Security Audit)**: Deterministic secrets scanning, credential redaction, internal IP and home path leak checks, blocking CRITICAL/HIGH findings.
  - **Gate 3 (Git Review & Human Approval)**: Task-owned file diff staging, repository identity guards (Ballo mismatch prevention), and interactive human decisions (`push` to remote or `keep_local` on disk). Standalone sessions without workspace file changes complete cleanly without manufacturing Git commits.

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
- PM2 installed for your user (`$HOME/.local/npm/bin/pm2`)

### Installation & Run

1. **Clone & install dependencies**
   ```bash
   git clone git@github.com:lukman-ss/codeorchestrator.git coding-orchestrator
   cd coding-orchestrator
   npm ci
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   chmod 600 .env
   # Edit .env: replace all /path/to/... placeholders with your absolute paths
   # Fill ORCHESTRATOR_API_TOKEN and NINEROUTER_API_KEY
   ```

3. **Start server with PM2**
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 status
   pm2 logs coding-orchestrator --lines 20
   ```

4. **Install CLI & open TUI**
   ```bash
   npm install --global --prefix $HOME/.local/npm .
   command -v co
   co tui
   ```

### Detailed Guides

- **[Getting Started](docs/getting-started.md)** — Installation, configuration, first task
- **[Configuration](docs/configuration.md)** — Environment variables reference
- **[Deployment](docs/deployment.md)** — PM2 setup, restarts, recovery after reboot
- **[Operations](docs/operations.md)** — Monitoring, logs, database inspection
- **[Troubleshooting](docs/troubleshooting.md)** — Common issues and fixes

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
| `ORCHESTRATOR_API_URL` | `http://127.0.0.1:4000` | Base URL for CLI/TUI client API calls |

See [Configuration Guide](docs/configuration.md) for all options.

## API & WebSocket Summary

- **Health Probes**: `GET /health`, `GET /ready`
- **Sessions**: `POST /sessions`, `GET /sessions/:id`, `POST /sessions/:id/messages`
- **Projects**: `POST /projects`, `GET /projects`, `POST /projects/import`
- **Tasks**: `POST /projects/:id/tasks`, `GET /tasks`, `GET /tasks/:id`
- **Approvals**: `GET /approvals/pending`, `POST /approvals/:id/decide`
- **WebSocket**: Connect to `ws://HOST:PORT/ws` and subscribe

## Discord Bot Integration

CodeOrchestrator includes an isolated Discord Bridge (`integrations/discord/`) implementing natural chat conversations and slash commands under `/code`. For full documentation, see [Discord Integration Guide](docs/discord-integration.md).

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
