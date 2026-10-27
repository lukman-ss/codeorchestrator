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

#### Natural Chat (Mention & Reply)
- **Start or Continue via Mention**: Mentioning `@Agent Coding <prompt>` in an authorized channel triggers natural conversation. If an active conversation exists for the user in the channel/thread, it continues that session. Otherwise, a fresh standalone session is created (`project_id = NULL`).
- **Continue via Direct Reply**: Replying directly to any message sent by the bot routes the prompt into the associated OpenCode session.
- **Historical Session Branching**: Replying to an older bot message routes specifically to that historical session, allowing users to revisit earlier conversation topics without conflating them with recent chats.
- **Scope & Privacy**: Scope defaults to one active standalone session per user per channel/thread. User B cannot reply to or hijack User A's private standalone session.
- **Chunking & Attachments**: Responses are split safely at <= 1,900 chars. If a response exceeds 3 chunks, chunk 0 is sent with a sanitized `.txt` attachment containing the complete response.
- **Intent Handling**: Attempts to connect with `GatewayIntentBits.MessageContent`. If the intent is disabled in Discord Developer Portal, it gracefully catches `DisallowedIntents` and falls back to standard intents (`Guilds`, `GuildMessages`), keeping mention-based natural chat fully operational.

#### `/code chat prompt:<text> [session:<id>] [model:<model>]`
- Starts a new standalone session or continues an existing conversation.
- If `session` is omitted, automatically spins up a standalone session (no workspace or project created).
- Retains conversational context via real OpenCode continuation.

#### `/code session new title:<text> [project:<name>] [model:<model>]`
- Explicitly creates a new interactive session.
- If `project` is omitted: Creates an independent Standalone Session (`project_id = NULL`).
- If `project` is provided: Creates a Project-Linked Session scoped to that workspace.

#### `/code session info [session:<id>]`
- Inspects session metadata, OpenCode session ID, type, status, model, and message history count.
- If `session` is omitted, displays metadata for the user's active conversation in the current channel.

#### `/code session close [session:<id>]`
- Archives the active conversation and sets session status to `closed` without deleting history.
- Next mention or chat interaction in the channel starts a fresh standalone session.

#### `/code resume session:<id> prompt:<text>`
- Continues an existing OpenCode session with follow-up instructions or queries.

#### `/code sessions [project:<name>] [page:<num>]`
- Lists accessible sessions (both Standalone and Project-linked).
- Shows ID, type, status, model, and last update time.

### Workspace Projects & Automation

#### `/code project create name:<text>`
- Initiates an interactive modal form for creating a new project.
- **Interactive Modal**: Allows specifying Project Name (pre-filled), Description, GitHub Repository URL, and Branch.
- **Safety & Confirmation Card**: Displays configuration summary with "Create Project" and "Cancel" buttons. Rejects double-clicks, expired tokens, and cross-user clicks.
- **Asynchronous Execution & Status Polling**: Clones the repo asynchronously, polls `GET /projects/operations/:id`, and updates the user in real-time (`Cloning repository...`, `Registering project...`, `Project Created Successfully!`).

#### `/code project import directory:<name> [name:<text>]`
- Registers an unmanaged existing folder within `WORKSPACE_ROOT` as a project.
- Automatically inspects the codebase for Git remotes (`origin`) and detects the technology stack (React, Node.js, Go, Rust, Python, etc.).

#### `/code project info project:<name/slug/id>`
- Displays comprehensive metadata for a specific project workspace.
- Redacts absolute host filesystem paths and displays safe relative slugs.
- Shows Git remote configuration, default branch, model, session count, and task counts.

#### `/code projects [page:<num>]`
- Lists available coding workspaces. Automatically filters out test projects (`is_test = 0`).
- Displays relative slugs, Git remote status (`Configured` / `Not configured`), and default model without leaking host directories.

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

- Messages strictly adhere to Discord's 2,000-character ceiling with a safe limit of 1,900 chars per chunk.
- Chunks are split at paragraph boundaries (`\n\n`), code block boundaries, or lines (`\n`), never breaking Unicode surrogate pairs.
- Up to 3 chunks are delivered sequentially (chunk 0 as reply, chunks 1-2 sent directly to channel).
- When a response exceeds 3 chunks, chunk 0 is sent with an attached sanitized `response.txt` file containing the full output.
- All chunk message IDs are persisted into `discord_session_messages` with status `completed`.

---

## 5. Idempotency, Session Queuing & Lifecycle

- **Message States**: Every incoming natural chat turn and slash message is tracked in `discord_session_messages` across states: `received` → `queued` → `running` → `completed` (or `failed`).
- **Duplicate Prevention**: Redelivered Discord message IDs in `running` or `completed` states are dropped immediately.
- **Session Mutex / Serialization**: Multiple concurrent messages targeted to the same session are serialized sequentially in-memory (`serializeSession`) and backend session locks to avoid concurrent OpenCode context corruption.
- **Startup Reconciliation**: On bridge start or restart, `reconcileRunningMessages()` reconciles any lingering `received`, `queued`, or `running` records to `failed` (`Bridge restart during execution`). Backend `recoverSessions()` resets `active` sessions back to `idle`.
