# Testing Guide

Coding Orchestrator utilizes the native Node.js test runner (`node:test` and `node:assert/strict`) without external testing dependencies.

## Test Commands

```bash
# Run all automated tests
npm test

# Run a specific test suite
node --test tests/basic.test.js
node --test tests/multi-agent-system.test.js
node --test tests/multi-agent-system-part2.test.js
node --test tests/security-check.test.js
```

---

## Test Suites Breakdown

### 1. `tests/basic.test.js`
- **Scope**: REST API, task queue, and WebSocket streaming.
- **Coverage**:
  - `GET /health` probe verification.
  - `POST /projects` creates project directory and database record.
  - `GET /projects` lists registered projects.
  - `POST /projects/:id/tasks` creates and enqueues task.
  - WebSocket subscription and event streaming (`task.started`, `task.queued`, `task.progress`).
  - Terminal state transition polling (`completed` or `failed`).

### 2. `tests/multi-agent-system.test.js`
- **Scope**: Core service unit tests (no server or model gateway required).
- **Coverage**:
  - `RequirementExtractor`: Parses complex Markdown lists, maps `requirement_id` (`REQ-001`), identifies mandatory vs optional items.
  - `WorktreeManager`: Creates and cleans isolated Git worktrees and branches.
  - `ParallelScheduler`: Enforces role and global capacity limits (`hasCapacity`, `claimSlot`, `releaseSlot`).
  - State machine transition validation (`validateSubtaskStatusTransition`).

### 3. `tests/multi-agent-system-part2.test.js`
- **Scope**: Integration tests for concurrency, dependencies, recovery, and conflicts.
- **Coverage**:
  - Parallel workers executing concurrent subtasks.
  - Dependency scheduling ensuring child tasks execute only after parents complete.
  - Crash recovery: Server termination via `kill -TERM` during task execution; validates that orphaned tasks reconcile to `interrupted`.
  - Integration conflict handling when concurrent tasks write conflicting files.

### 4. `tests/security-check.test.js`
- **Scope**: Pre-release security gate validation.
- **Coverage**:
  - Executes `scripts/security-check.sh` on the codebase.
  - Validates detection of synthetic credential patterns using `tests/fixtures/synthetic-leak.env`.
  - Confirms clean fixtures (`tests/fixtures/synthetic-clean.env`) do not trigger false positives.

---

## Standalone Acceptance & E2E Scripts

In addition to the unit test suites, two comprehensive end-to-end verification scripts are included:

```bash
# End-to-end acceptance audit with real OpenCode processes
node tests/acceptance-audit.js

# Full API and WebSocket integration audit
node tests/audit-e2e.js
```

*Requirements for full E2E scripts*:
- `NINEROUTER_API_KEY` set in environment.
- Live internet connectivity to reach the LLM gateway.
- `opencode` binary installed and accessible.
