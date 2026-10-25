# Parallel Scheduler & Concurrency Control

The `ParallelScheduler` (`src/services/parallel-scheduler.js`) governs process allocation, role-based capacity limits, and dependency resolution across all multi-agent workflows.

## Concurrency Governance

```mermaid
flowchart TD
    Job[Incoming Subtasks] --> CheckSlots{Has Slot Capacity?}
    CheckSlots -->|Global Running >= MAX_GLOBAL| Queue[Wait in Queue]
    CheckSlots -->|Role Running >= Role Max| Queue
    CheckSlots -->|Capacity Available| Claim[claimSlot(role)]
    
    Claim --> Dispatch[Spawn Agent Subprocess]
    Dispatch --> Exit[Process Terminates]
    Exit --> Release[releaseSlot(role)]
    Release --> Trigger[Supervisor.schedule(jobId)]
```

### Capacity Ceilings

The scheduler maintains an in-memory accounting of active subprocesses (`runningByRole` and `globalRunning`):

```javascript
static MAX_PARALLEL_WORKERS = Number(process.env.MAX_PARALLEL_WORKERS || 3);
static MAX_PARALLEL_AUDITORS = Number(process.env.MAX_PARALLEL_AUDITORS || 2);
static MAX_PARALLEL_INTEGRATIONS = Number(process.env.MAX_PARALLEL_INTEGRATIONS || 1);
static MAX_GLOBAL_AGENT_PROCESSES = Number(process.env.MAX_GLOBAL_AGENT_PROCESSES || 5);
```

An execution slot is granted only when:
1. `globalRunning < MAX_GLOBAL_AGENT_PROCESSES`
2. `runningByRole[role] < RoleMax[role]`

---

## Dependency DAG Evaluation

A subtask is eligible for execution only when all prerequisites defined in `depends_on_json` have attained `integration_passed` or `completed` status:

```javascript
const depsMet = deps.every(d => completed.has(d));
```

### Cycle Detection

Before scheduling eligible subtasks, `ParallelScheduler.detectCycle(jobId)` performs a depth-first search (DFS) over the `dependency_edges` table. If any back-edge or loop is found:
- The subtask transitions to `blocked`.
- The reason `'dependency cycle detected'` is logged.
- Further execution is paused to prevent infinite loops.

---

## Subtask Status Transitions

The scheduler enforces a strict state machine to prevent illegal out-of-order transitions:

```javascript
const validTransitions = {
  pending: ['queued', 'blocked', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['implementation_done', 'audit_failed', 'failed', 'cancelled', 'interrupted'],
  implementation_done: ['audit_pending', 'auditing'],
  audit_pending: ['auditing'],
  auditing: ['audit_passed', 'audit_failed'],
  audit_passed: ['integration_pending', 'integrating'],
  audit_failed: ['repair_pending', 'repair_running', 'blocked'],
  repair_pending: ['repair_running', 'blocked'],
  repair_running: ['implementation_done', 'audit_failed', 'blocked'],
  integration_pending: ['integrating'],
  integrating: ['integration_passed', 'integration_failed', 'completed', 'blocked'],
  integration_passed: ['completed']
};
```

Any attempted transition not present in this map is rejected, preserving state integrity across concurrent threads.
