# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-25

### Added
- Fastify HTTP server providing project, session, and task execution endpoints.
- WebSocket server (`/ws`) for live event streaming and sequence-based replay.
- SQLite persistence layer for projects, sessions, tasks, and task event logs.
- Task queue with per-project and global concurrency limits.
- Child process runner spawning `opencode` with buffered stdio streaming.
- Automated health check (`/health`) and readiness check (`/ready`) endpoints.
- Pre-commit security verification gate (`scripts/security-check.sh`).
- Pre-release validation pipeline (`scripts/public-release-check.sh`).
- Comprehensive technical documentation suite across architecture, API, scheduler, and operations.

## [1.0.1] - 2026-11-03

### Added
- Repository role classification (`STARTER`, `FRAMEWORK_DEPENDENCY`, `TEMPLATE`, `TARGET`, etc.) and authority precedence resolver (`src/services/repository-classifier.js`, `src/services/project-context-resolver.js`).
- Pre-execution scope conflict guard (`SCOPE_CONFLICT`) preventing unauthorized external repository mutations before worker/agent spawn.
- Canonical Git URL normalization (`normalizeGitUrl`, `areEquivalentGitUrls`) matching HTTPS, SSH SCP, SSH URI, and configured aliases across case variations.
- False-mismatch task recovery service (`recoverRepositoryMismatchTask`) progressing blocked tasks directly to Gate 3 without re-running OpenCode.
- Repository references audit persistence (`repository_references` table).
- Autonomous AI model selection & failover (router) (commit 9e7462c).
- 3‑gate completion pipeline & approval service (commit f2056fa).
- Discord natural‑chat memory, attachments, multipart handling (commits 5e4cd6d, c40c3d6).
- Async WebSocket streaming for realtime (commit aa42c79).
- Prompt size enforcement (commit 835adc6).
- Workspace remote auto‑conversion SSH↔HTTPS (commit d7c8989).

### Fixed
- False repository mismatch when prompts cite starter templates or foundation repositories (e.g. `ballo-starter` on `ballo-todo`).
- CLI run ordering & flag removal (commit 0a69df2).
- Redundant terminal state spam (commit 950ac76).
- Discord message length limits (commit 463b817).

### Changed
- Refactored `createTask` and `Supervisor.createJob` to enforce pre-execution project context and scope conflict validation.
- Updated technical documentation (`docs/project-management.md`, `docs/audit-and-verification.md`, `docs/discord-integration.md`).


