# CodeOrchestrator — Discord Bridge

Dedicated Discord integration service for CodeOrchestrator.

## Architecture

```
Discord User / Guild
        │ (Slash commands & Autocomplete)
        ▼
 Discord Bridge (discord.js)
   ├── REST Client ──► CodeOrchestrator REST API (POST /projects/:id/tasks, POST /jobs, etc.)
   ├── WebSocket   ◄── CodeOrchestrator Event Stream (/ws)
   └── Persistence ──► SQLite (discord_executions mapping table)
```

## Features

- **Slash Command Group**: `/code` with subcommands:
  - `projects`: List authorized projects
  - `run`: Submit single task
  - `job`: Submit multi-agent workflow
  - `status`: Check task or job progress
  - `audit`: Retrieve independent auditor verdicts
  - `report`: Retrieve final execution report
  - `cancel`: Cancel task or job with explicit confirmation
  - `help`: Command usage guide
- **Real-Time Progress**: Live updates to a single persistent Discord message per task/job.
- **Fail-Safe Persistence**: Mapping between Discord messages and jobs persists in SQLite (`data/bridge.db`).
- **Throttling & Rate-Limit Protection**: Live message edits throttled to 2 seconds; terminal state flushes immediately.
- **Strict Authorization & Channel Discovery**: Guild, user, role, and project-level allowlists. Channel IDs are discovered automatically via Discord interactions and bounded by native Discord permissions; optional channel allowlist is supported. All progress routes strictly to the originating channel.
- **Confidentiality & Redaction**: Automatically scrubs API keys, bearer tokens, private keys, RFC1918/Tailscale IPs, and deployment home directory paths.
- **Mentions Suppression**: Enforces `allowedMentions: { parse: [] }` on all Discord messages.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment (in root .env)
# DISCORD_BOT_TOKEN=...
# DISCORD_CLIENT_ID=...
# DISCORD_ALLOWED_GUILD_IDS=...
# DISCORD_ALLOWED_USER_IDS=...
# DISCORD_ALLOWED_CHANNEL_IDS= (Optional: leave blank for automatic discovery)

# 3. Run unit tests
npm test

# 4. Start service
npm start
```

For complete deployment and developer documentation, see `docs/discord-integration.md`.
