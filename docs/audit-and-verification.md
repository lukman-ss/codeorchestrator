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
