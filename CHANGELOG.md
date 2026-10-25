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
