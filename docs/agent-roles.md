# Agent Roles & Capabilities

Coding Orchestrator decomposes software engineering tasks into specialized agent roles with distinct security contexts and concurrency ceilings.

## Role Matrix

| Role | Concurrency Limit | Model Config Override | Primary Artifacts |
|---|---|---|---|
| **Supervisor** | 1 per active job | `SUPERVISOR_MODEL` | `jobs`, `job_requirements`, `dependency_edges` |
| **Worker** | `MAX_PARALLEL_WORKERS` (3) | `WORKER_MODEL` | Worktree branch, source modifications |
| **Auditor** | `MAX_PARALLEL_AUDITORS` (2) | `AUDITOR_MODEL` / `AUDIT_MODEL` | `agent_audits`, test execution logs |
| **Repair** | 1 concurrent per job | `WORKER_MODEL` | Patch diffs, re-audit triggers |
| **Integration**| `MAX_PARALLEL_INTEGRATIONS` (1) | `INTEGRATION_MODEL` | `agent_integration_results`, merge commits |
| **Final Auditor**| Transient | `AUDITOR_MODEL` | `jobs.report_json`, final completion verdict |

---

## Detailed Role Responsibilities

### Supervisor
- **Entrypoint**: `src/services/supervisor.js`
- **Model**: Default `DEFAULT_MODEL` or `SUPERVISOR_MODEL`.
- **Purpose**: High-level planner. Parses Markdown specification prompts, maps requirement dependencies, detects dependency cycles, and initiates the execution DAG.

### Worker
- **Entrypoint**: `src/services/agent-execution-engine.js:startWorker()`
- **Model**: Default `DEFAULT_MODEL` or `WORKER_MODEL`.
- **Isolation**: Operates inside dedicated Git worktrees when available.
- **Purpose**: Writes code, implements functionality, and creates initial unit tests.

### Auditor
- **Entrypoint**: `src/services/agent-execution-engine.js:startAuditor()`
- **Model**: `AUDIT_MODEL_OVERRIDE`, `AUDITOR_MODEL`, or `DEFAULT_MODEL`.
- **Purpose**: Adversarial verification. Evaluates the Worker's output without implementing features. Verifies acceptance criteria using runnable command assertions.

### Repair
- **Entrypoint**: `src/services/repair-integration-audit.js:attemptRepair()`
- **Model**: `WORKER_MODEL` or `DEFAULT_MODEL`.
- **Purpose**: Focuses exclusively on failing criteria identified in `agent_audits`. Has bounded retries (`MAX_REPAIR_ATTEMPTS`).

### Integration
- **Entrypoint**: `src/services/repair-integration-audit.js:startIntegration()`
- **Model**: `INTEGRATION_MODEL_OVERRIDE`, `INTEGRATION_MODEL`, or `DEFAULT_MODEL`.
- **Purpose**: Merge coordinator. Acquires the project's exclusive integration lock (`integration_locks`), merges the agent branch into the canonical repository, executes integration tests, and releases the lock.
