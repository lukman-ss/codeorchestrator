# Audit & Independent Verification

In autonomous software development, self-evaluation by the implementing agent introduces confirmation bias. Coding Orchestrator enforces strict separation of concerns through independent Auditor agents.

## Verification Philosophy

1. **Independent Evaluation Context**: The Auditor agent runs in a fresh, isolated OpenCode context. It does not share working memory or conversation history with the Worker that authored the code.
2. **Ground Truth Over Generation**: The Auditor must execute concrete verification commands (e.g. running tests, type checks, linting, syntax validation) rather than reviewing code cosmetically.
3. **No Fabricated Evidence**: Prompt instructions explicitly mandate:
   > "Do NOT fabricate evidence. Execute relevant verification commands."
4. **Structured Decision Contract**: The Auditor outputs a strict JSON payload containing the verdict, test invocations, and findings.

---

## Verdict Definitions

| Verdict | Meaning | Next Step |
|---|---|---|
| `PASS` | All acceptance criteria validated with concrete command evidence. | Proceeds to Integration Agent. |
| `FAILED` | One or more acceptance criteria failed or command exited non-zero. | Routed to Repair Agent. |
| `BLOCKED` | Auditor encountered a broken environment, missing toolchain, or unrecoverable dependency. | Operator intervention required. |

---

## Audit Record Schema

Audits are persisted in the `agent_audits` table:

```json
{
  "id": "audit-uuid-1234",
  "jobId": "job-uuid-5678",
  "subtaskId": "subtask-uuid-9012",
  "sourceRevision": "a1b2c3d4e5f6...",
  "verdict": "PASS",
  "criteria": [
    "POST /projects returns 201 Created",
    "Slug regex validation rejects spaces"
  ],
  "tests": [
    "node --test tests/project-validation.test.js"
  ],
  "evidence": {
    "command": "node --test tests/project-validation.test.js",
    "exitCode": 0,
    "stdout": "✔ slug validation passed"
  },
  "findings": [],
  "summary": "Verified all acceptance criteria via automated test assertions."
}
```

---

## Three Completion Gates Pipeline

Before marking any single task or multi-agent job `completed`, the system coordinates through `WorkflowService`:

### Gate 1: Implementation Verification (`ImplementationVerifier`)
- Automatically detects the workspace technology stack (Node.js, Go, Rust, Python, etc.).
- Runs stack-specific syntax validation (`node -c`, `go vet`, `cargo check`, `python -m py_compile`).
- Identifies and runs automated test suites (`npm test`, `go test`, `cargo test`, `pytest`).
- Validates prompt criteria and acceptance rules against execution logs and outputs.
- Any syntax failure or test error halts the workflow in `failed` status.

### Gate 2: Independent Security Audit (`SecurityAuditor`)
- Analyzes git diffs of task-modified files.
- Deterministic scanner inspects for leaked secrets, API keys (synthetic AWS keys, GitHub tokens, generic API keys), private keys, internal IP disclosures (`10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`), and host path disclosures (`/home/<user>`).
- Redacts sensitive evidence strings (`AWS_ACCESS_KEY_ID: [REDACTED]`) before database storage or Discord rendering.
- Evaluates external scanners (e.g. Gitleaks) when installed; explicitly tracks limitations if toolchains are absent.
- Blocks workflows on `CRITICAL` or `HIGH` findings.

### Gate 3: Git Review & Human Approval (`ApprovalService` & `GitOperations`)
- Baseline difference tracking isolates strictly task-owned changes from other workspace modifications.
- Enforces repository identity validation: checks remote URL against registered project metadata, preventing accidental pushes across repos (such as `ballo` workspace mismatch guards).
- Never executes `git add .` or `git add -A`. Only task-owned files are staged.
- Requires explicit human authorization via Discord interactive buttons or `/code approve` / `/code review`:
  - **Push to GitHub**: Stages task-owned files, commits with structured message, and executes non-interactive push (`GIT_TERMINAL_PROMPT=0`). Blocks on remote divergence.
  - **Keep Local**: Preserves modifications on disk without committing or pushing, transitioning the workflow cleanly to `completed`.
  - **Reject**: Aborts the workflow without pushing.
- Workflows with 0 modified files (or standalone sessions) complete cleanly without generating empty Git commits.

---

## Repair Loop & Termination

When an audit returns `FAILED`:
1. The failure findings and criteria are bundled into a repair packet.
2. If `attempt < MAX_REPAIR_ATTEMPTS` (default: 2), the `RepairAgent` is dispatched to fix the codebase.
3. When the repair completes with exit code 0, an auditor is immediately respawned to confirm the fix.
4. If the retry threshold is reached without passing, the subtask transitions to `blocked` to halt compounding errors.

## Limitations of Autonomous Auditing

- **Test Quality Dependence**: An auditor is only as effective as the acceptance criteria and test assertions supplied in the prompt or codebase.
- **Model Hallucination Risk**: While prompt guidelines forbid fabrication, an LLM auditor may misinterpret ambiguous test failures without human review.
- **Non-Sandboxed Side Effects**: Auditors run commands in the local environment; destructive test suites can still alter the system if not containerized.
