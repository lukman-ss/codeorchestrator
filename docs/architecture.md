# Coding Orchestrator Architecture

## Overview

Coding Orchestrator is an autonomous agent control plane designed to execute complex, multi-stage software engineering tasks. It coordinates autonomous OpenCode coding engines across isolated Git worktrees, enforces independent verification audits, manages merge conflicts, and maintains persistent state in SQLite.

```mermaid
flowchart TD
    Client[REST / WebSocket Client] -->|HTTP / WS| Server[Fastify & WS Server]
    Server --> Auth[Auth Gate & Redaction]
    Auth --> Router[Control Plane Router]
    
    subgraph Core Services
        Router --> TaskQueue[Task Queue & Concurrency Controller]
        Router --> JobSupervisor[Supervisor & Planner]
        JobSupervisor --> Scheduler[Parallel Scheduler]
        JobSupervisor --> Extractor[Requirement Extractor]
    end

    subgraph State Plane
        TaskQueue --> DB[(SQLite WAL DB)]
        JobSupervisor --> DB
        Scheduler --> DB
    end

    subgraph Execution Plane
        Scheduler --> Worker[Worker Agent Process]
        Worker --> WT[Git Worktree Isolation]
        WT --> OpenCodeWorker[OpenCode Engine]
        
        Worker --> Auditor[Independent Auditor]
        Auditor --> OpenCodeAuditor[OpenCode Audit Engine]
        
        Auditor -->|Audit Passed| Integrator[Integration Agent]
        Auditor -->|Audit Failed| Repair[Repair Agent]
        Repair --> Worker
        
        Integrator --> MainRepo[Canonical Workspace Repo]
    end
```

## System Boundaries

- **Client Plane**: External tools, developer CLIs, Discord/chat bridge interfaces communicating over authenticated HTTP REST and WebSocket connections.
- **Control Plane**: Fastify HTTP server with authentication pre-handlers, structured Pino logging with automatic credential redaction, request ID tracking, and disk pressure monitoring.
- **Orchestration Plane**: Task dispatch queue, Supervisor job decomposing engine, Parallel Scheduler managing concurrency slots, and Worktree Manager isolating file changes.
- **Execution Plane**: Sandboxed OpenCode child processes executed with non-interactive CLI flags (`--auto --pure --format json`).
- **Data Plane**: Single-file SQLite database configured with Write-Ahead Logging (`WAL`), foreign keys enabled, and automatic passive checkpointing.

## Execution Flows

### 1. Task Execution Lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant API as Fastify HTTP
    participant Queue as Task Queue
    participant DB as SQLite DB
    participant Engine as OpenCode Subprocess
    participant WS as WebSocket Bus

    Client->>API: POST /projects/:id/tasks { prompt, model }
    API->>DB: INSERT INTO tasks (status = 'queued')
    API->>Queue: enqueueTask(taskId)
    API-->>Client: 201 Created { id, status: 'queued' }
    
    Queue->>Queue: checkCapacity(project & global)
    Queue->>DB: UPDATE tasks SET status='running', started_at=now()
    Queue->>WS: emit('task.started')
    Queue->>Engine: spawn('opencode', ['--auto', '--pure', '--format', 'json', prompt])
    
    loop Stream JSON Lines
        Engine->>Queue: stdout (event chunks)
        Queue->>DB: INSERT INTO task_events
        Queue->>WS: emit('task.progress' / 'task.tool')
    end
    
    Engine->>Queue: exit(code)
    alt code == 0
        Queue->>DB: UPDATE tasks SET status='completed', finished_at=now()
        Queue->>WS: emit('task.completed')
    else code != 0
        Queue->>DB: UPDATE tasks SET status='failed', finished_at=now()
        Queue->>WS: emit('task.failed')
    end
```

### 2. Multi-Agent Job Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Planning: Supervisor.createJob()
    Planning --> Running: Requirements & Subtasks Created
    
    state Running {
        [*] --> SubtaskPending
        SubtaskPending --> Queued: Dependencies Satisfied
        Queued --> RunningWorker: Slot Claimed
        RunningWorker --> ImplementationDone: Exit 0
        RunningWorker --> AuditFailed: Exit Non-Zero
        
        ImplementationDone --> Auditing: Auditor Spawned
        Auditing --> AuditPassed: Acceptance PASS
        Auditing --> AuditFailed: Acceptance FAILED
        
        AuditFailed --> RepairPending: Attempts < Max
        AuditFailed --> Blocked: Attempts Exhausted
        RepairPending --> RepairRunning: Slot Claimed
        RepairRunning --> ImplementationDone: Fix Applied
        
        AuditPassed --> IntegrationPending: Lock Acquired
        IntegrationPending --> Integrating: Canonical Merge & Test
        Integrating --> Completed: Verdict PASS
        Integrating --> Blocked: Merge Conflict / Verification Fail
    }

    Running --> Completed: All Subtasks Done
    Running --> Blocked: Any Mandatory Unrecoverable
    Running --> Interrupted: Server Shutdown / Crash
```

### 3. Audit and Repair Loop

1. **Worker**: Generates code changes on a detached Git branch (`agent/<jobId>/<subtaskId>`) in an isolated worktree (`.agent-worktrees/<slug>/<jobId>/worker-<subtaskId>`).
2. **Auditor**: Launches independently on the worktree against explicitly defined acceptance criteria. Collects test output, syntax verification, and execution evidence.
3. **Verdict**: If `PASS`, proceeds to Integration. If `FAILED`, transfers control to the `RepairAgent`.
4. **Repair**: Receives the auditor's structured findings and the worktree context. Implements targeted corrections up to `MAX_REPAIR_ATTEMPTS` before marking the subtask `blocked`.

### 4. Integration Gate

To prevent corrupted Git histories and merge collisions, integration is guarded by project-level integration locks (`integration_locks` table):
- Only one agent can integrate into a canonical project workspace at any time.
- The Integration agent validates clean merges, executes project-level test commands, and records evidence in `agent_integration_results`.
- If a merge conflict occurs, the integration lock is released, and the subtask transitions to `blocked` for operator intervention.

### 5. Crash Recovery and State Reconciliation

- On startup (`src/server.js`), `recoverRunning()` queries all tasks marked as `running`.
- Any tasks orphaned by an unexpected server exit or machine reboot are transitioned to `interrupted`.
- Interrupted events are persisted to `task_events` and broadcast to WebSocket clients upon reconnection.
