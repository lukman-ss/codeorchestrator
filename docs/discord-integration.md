# CodeOrchestrator — Discord Bot Integration Guide

This guide details setup, configuration, security model, command workflows, and deployment for the CodeOrchestrator Discord Bridge service.

---

## 1. Overview & Architecture

The Discord Bridge is an isolated gateway service running alongside CodeOrchestrator:

```
[ Discord Client / Guild ]
           │
           │ (Slash commands & Autocomplete)
           ▼
[ Discord Bridge Service ]
   ├── Authentication & Allowlist Gate
   ├── REST Client ──────► [ CodeOrchestrator REST API ]
   │                       (POST /sessions, POST /sessions/:id/messages, POST /jobs, cancel, etc.)
   ├── Realtime WS ◄────── [ CodeOrchestrator WebSocket Plane ]
   │                       (task.*, job.*, agent.*, audit.*, integration.*)
   └── Persistence Store ─► [ SQLite bridge.db ]
```

### Architectural Invariants

- **No Direct OpenCode Execution**: The Discord Bridge never spawns `opencode` processes directly; it calls CodeOrchestrator REST endpoints.
- **Queue & Lock Preservation**: All tasks, multi-agent jobs, and session conversations respect scheduling queues and per-session concurrency mutexes.
- **Isolated Persistence**: The Bridge does not modify `orchestrator.db`; it tracks Discord interaction state in `bridge.db`.
- **Hermes Isolation**: Hermes remains independent. Bot tokens and settings are never shared.
- **Automatic Secret Redaction**: All messages, chunks, and logs pass through sensitive credential redaction before reaching Discord.

---

## 2. Slash Commands Specification

All commands are organized under the `/code` command group:

### Standalone & Interactive Sessions

#### `/code chat prompt:<text> [session:<id>] [model:<model>]`
- Starts a new standalone session or continues an existing conversation.
- If `session` is omitted, automatically spins up a standalone session (no workspace or project created).
- Retains conversational context via real OpenCode continuation.

#### `/code session title:<text> [project:<name>] [model:<model>]`
- Creates an interactive session.
- If `project` is omitted: Creates an independent Standalone Session.
- If `project` is provided: Creates a Project-Linked Session scoped to that workspace.

#### `/code resume session:<id> prompt:<text>`
- Continues an existing OpenCode session with follow-up instructions or queries.

#### `/code sessions [project:<name>] [page:<num>]`
- Lists accessible sessions (both Standalone and Project-linked).
- Shows ID, type, status, model, and last update time.

### Workspace Projects & Automation

#### `/code projects [page:<num>]`
- Lists available coding workspaces. Automatically filters out test projects (`is_test = 0`).

#### `/code run project:<name> prompt:<text>`
- Submits an individual task to the execution queue for a project workspace.

#### `/code job project:<name> [prompt:<text>] [attachment:<file>]`
- Submits a multi-agent workflow with automated planning, parallel workers, independent auditors, and integration steps. Supports `.txt` and `.md` prompt attachments up to 1MB.

#### `/code status id:<id>`
- Queries real-time status of a running task, multi-agent job, or session.

#### `/code audit id:<id>`
- Displays independent auditor verdicts, criteria evaluation, and evidence.

#### `/code report id:<id>`
- Retrieves the full final execution summary, files modified, and test verification report.

#### `/code cancel id:<id> [confirm:True]`
- Idempotently cancels an active task or job. Requires explicit `confirm:True`.

#### `/code help`
- Displays command summary and usage instructions.

---

## 3. Configuration & Permissions

Environment variables in `integrations/discord/.env`:

| Variable | Description | Default |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Bot user token from Discord Portal | *Required* |
| `DISCORD_CLIENT_ID` | Application ID | *Required* |
| `ORCHESTRATOR_API_URL` | Base HTTP URL for CodeOrchestrator | `http://127.0.0.1:4000` |
| `ORCHESTRATOR_WS_URL` | Base WS URL for CodeOrchestrator | `ws://127.0.0.1:4000/ws` |
| `ORCHESTRATOR_API_TOKEN` | Bearer token for authentication | *Required* |
| `DISCORD_ALLOWED_GUILDS` | Comma-separated list of allowed Guild IDs | *Required* |
| `DISCORD_ALLOWED_ROLES` | Comma-separated list of authorized Role IDs | *Optional* |
| `DISCORD_ALLOWED_USERS` | Comma-separated list of authorized User IDs | *Optional* |

---

## 4. Message Size & Splitting Rules

- Messages strictly adhere to Discord's 2,000-character ceiling.
- Chunks are split at paragraph boundaries (`\n\n`), code block boundaries, or lines (`\n`), never breaking Unicode surrogate pairs.
- Large execution reports or audit outputs exceeding 1,800 characters are formatted as clean Markdown summaries with a full `.txt` sanitized file attachment.
