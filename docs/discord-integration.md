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

#### `/code project repair project:<name/slug/id> confirm:True [repourl:<url>] [branch:<name>]`
- Safely updates project repository metadata without deleting or mutating existing checkouts on disk.
- Requires explicit `confirm:True` and admin or project-creator privileges.
- Resolves workspace remote mismatches when remotes or intended repository URLs change.

#### `/code prompt start [project:<name>]`
- Begins collecting multipart specification chunks in the current channel.
- Optionally links collected chunks to an explicit project workspace.

#### `/code prompt submit`
- Assembles all collected chunks in chronological order, computes SHA-256 integrity hash, stores durable artifact with `0600` permissions, and renders acknowledgment card.

#### `/code prompt cancel`
- Cancels an in-progress multipart specification collection and cleans up staged chunks.

#### `/code projects [page:<num>]`
- Lists available coding workspaces. Automatically filters out test projects (`is_test = 0`).
- Displays relative slugs, Git remote status (`Configured` / `Not configured`), and default model without leaking host directories.

#### `/code run project:<name> prompt:<text>`
- Submits an individual task to the execution queue for a project workspace.

#### `/code job project:<name> [prompt:<text>] [attachment:<file>]`
- Submits a multi-agent workflow with automated planning, parallel workers, independent auditors, and integration steps. Supports `.txt` and `.md` prompt attachments up to 256KB (`MAX_ATTACHMENT_BYTES`).

#### `/code status id:<id>`
- Queries real-time status of a running task, multi-agent job, or session.

#### `/code audit id:<id>`
- Displays independent auditor verdicts, criteria evaluation, and evidence.

#### `/code report id:<id>`
- Retrieves the full final execution summary, files modified, and test verification report.

#### `/code approvals [project:<name>]`
- Lists pending Git approval requests awaiting human review across projects.

#### `/code review id:<id>`
- Displays the 3-gate review card for a task or job, showing Gate 1 (Verification), Gate 2 (Security Audit), and Gate 3 (Git Review) with interactive `[Push to GitHub]`, `[Keep Local]`, and `[Reject]` buttons.

#### `/code approve id:<id> decision:<push|keep_local|reject>`
- Submits an explicit human approval decision directly via slash command.

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

---

## 6. Long Specification Inputs & Attachment Handling

To overcome Discord's 2,000-character single-message ceiling for rich specifications, the bridge supports 4 distinct input methods:

### Supported Input Methods
1. **Normal Mention**: Direct message mention (`@Agent Coding <prompt>`) for standard conversational prompts.
2. **Reply with Attachment**: Reply to an existing bot message with a `.txt` or `.md` attachment to continue the session with a long specification.
3. **Mention with Attachment**: Mention the bot with a `.txt` or `.md` attachment to stage a specification for a fresh standalone session.
4. **Multipart Prompts (`/code prompt`)**: For specifications sent across multiple chat messages:
   - Run `/code prompt start [project:<name>]` to open a collection window.
   - Send specification chunks into the channel.
   - Run `/code prompt submit` to assemble and stage execution.
   - Run `/code prompt cancel` to abort collection.
   - Chunks are stored in SQLite (`discord_multipart_prompts`, `discord_multipart_chunks`) and survive bot restarts.

### Attachment Validation & Security
- **Extensions**: Only `.txt` and `.md` files are accepted.
- **Size Bounds**: Maximum `MAX_ATTACHMENT_BYTES` (262,144 bytes / 256KB).
- **Format Integrity**: UTF-8 only. Non-empty (0 bytes rejected) and binary null byte (`0x00`) detection rejects binaries and compiled files.
- **Origin Validation**: Downloads restricted to official Discord CDN hosts (`cdn.discordapp.com` and `media.discordapp.net`).
- **Download Bounds**: Enforces 15-second download timeouts and strict byte consumption bounds.
- **Storage & Artifacts**: Full prompt text is saved in `data/prompt-artifacts/` with restrictive file permissions (`0600`) and directory permissions (`0700`), accompanied by SHA-256 digests.

### Interactive Lifecycle Cards
- **Specification Received**: Displays prompt size, chunk/attachment metadata, SHA-256 digest, target project or session, and interactive `[Execute]` and `[Cancel]` buttons.
- **Cross-User Protection**: Only the submission author or an administrator can trigger `[Execute]` or `[Cancel]`. Other users receive `❌ Only the submission author can execute or cancel this specification.`
- **Execution Started**: Replaces buttons with real-time status and submission tracking ID.
- **Execution Result**: Renders final output inline (<= 2,000 characters) or attaches a sanitized `.txt` file for large outputs.

---

## 7. Workspace Safety & Critical Ballo Safeguards

- **Identity & Remote Verification**: Before running tasks, multi-agent jobs, or creating project sessions, the backend verifies that the local workspace git remote origin matches the registered project identity.
- **Ballo Protection**: Project `ballo` requires its intended Go repository `https://github.com/lukman-ss/ballo`. If the local workspace points to `codeorchestrator` or any non-Ballo repository, execution is blocked immediately without filesystem mutation or checkout deletion.
- **Safe Repair Workflow**: When remotes or project configurations change, administrators can invoke `/code project repair project:<id> confirm:True [repourl:<url>]` to update database metadata cleanly without altering or deleting existing files on disk.

---

## 8. Completion Gates & Interactive Git Reviews

Before tasks or multi-agent jobs reach `completed` status, the backend executes three mandatory gates:
- **Gate 1 (Implementation Verification)**: Validates syntax, lints, and executes test suites.
- **Gate 2 (Independent Security Audit)**: Scans diffs for credentials, tokens, internal IP leaks, and `/home/<user>` paths.
- **Gate 3 (Git Review & Human Approval)**: Identifies task-owned modified files and requests human confirmation.

### Realtime Review Notifications
When a workflow enters `awaiting_approval`:
1. CodeOrchestrator emits `approval.requested` over WebSocket.
2. The Discord Event Listener catches the event and renders an interactive **Git Review & Human Approval** card into the originating channel.
3. The embed displays:
   - Target Project & Remote Repository
   - Git Branch & Proposed Commit Message
   - Files Changed (additions, modifications, deletions)
   - Gate 1 & Gate 2 Pass Status & Findings
   - Action buttons:
     - `[Push to GitHub]` (`btn_git_push_<id>`): Commits task-owned files and pushes non-interactively to the configured remote.
     - `[Keep Local]` (`btn_git_keeplocal_<id>`): Preserves workspace files on disk without committing or pushing, completing the workflow.
     - `[Reject]` (`btn_git_reject_<id>`): Marks the workflow failed and discards the pending approval.

### Safety & Idempotency Guarantees
- **Standalone Sessions & Zero Changes**: Tasks without workspace file changes complete cleanly with `noChanges: true` without prompting Git push.
- **Task Ownership Only**: Git commit and push stage only task-owned files (never `git add .` or `git add -A`).
- **Remote Divergence**: Rejects pushes when remote has diverged without force-pushing.
- **Replay Protection**: Decided approvals transition to terminal states (`approved_pushed`, `approved_local`, `rejected`) and cannot be replayed.
