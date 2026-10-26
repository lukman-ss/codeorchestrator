# Security Policy & Threat Model

## Threat Model

Coding Orchestrator spawns autonomous coding agents capable of reading, generating, modifying, and executing arbitrary code. Deploying autonomous execution engines carries inherent security considerations.

### Threat Vectors

1. **Unauthorized Control Plane Access**:
   - *Risk*: An attacker gaining access to the REST or WebSocket endpoints could submit arbitrary commands, exfiltrate project code, or deplete LLM API budgets.
   - *Mitigation*: Constant-time token verification (`ORCHESTRATOR_API_TOKEN`) on all non-probe endpoints; WebSocket handshake authentication; default loopback binding (`127.0.0.1`).

2. **Credential & Secret Leakage**:
   - *Risk*: API tokens, LLM gateway credentials, or private SSH keys appearing in application logs, database event payloads, HTTP error responses, or Git repositories.
   - *Mitigation*: Automated Pino log redaction (`headers.authorization`, `req.body.prompt`); pre-commit security gates; non-committal of runtime `.env` files via `.gitignore`; Discord outbound message redaction (`redactSensitive`).

3. **Workspace Boundary Bleed & Cross-Tenant Pollution**:
   - *Risk*: Standalone conversational sessions inadvertently reading, mutating, or overwriting project files or Git branches in operational workspaces.
   - *Mitigation*: Strict architectural boundary separation: Standalone Sessions execute exclusively in `SESSION_RUNTIME_ROOT/<sessionId>`, completely disassociated from `WORKSPACE_ROOT`. Relational SQLite `CHECK` constraints forbid sessions with missing or invalid project associations. Session rebinding across boundaries via `PATCH` is strictly prohibited.

4. **Concurrent Context Desynchronization**:
   - *Risk*: Multiple asynchronous requests to the same session corrupting upstream OpenCode conversation state.
   - *Mitigation*: Per-session in-memory mutex queues (`withSessionLock`) guarantee that turns on the same session are serialized sequentially.

5. **Filesystem & Path Traversal**:
   - *Risk*: Submitting malicious slugs (e.g. `../../etc`) to manipulate directories outside `WORKSPACE_ROOT`.
   - *Mitigation*: Strict regex enforcement on project slugs (`^[a-z0-9-]+$`) using Zod schemas; strict normalization using Node.js `path.resolve` and `path.join`.

6. **Arbitrary Code Execution & Sandbox Escape**:
   - *Risk*: OpenCode executes commands using the host shell. Git worktree isolation partitions Git branches but provides NO operating-system process isolation.
   - *Mitigation*: Run under a dedicated unprivileged OS user account; enforce systemd security directives (`NoNewPrivileges=true`, `ProtectSystem=strict`, `PrivateTmp=true`); recommend containerization in multi-tenant environments.

7. **Disk Exhaustion Denial of Service**:
   - *Risk*: Rapid creation of workspaces, logs, or large build artifacts exhausting server storage.
   - *Mitigation*: Real-time disk space checks before task queue insertion (`MIN_FREE_DISK_MB`, `MAX_DISK_USAGE_PERCENT`); automatic log rotation and event stream pruning.

---

## Implemented Security Controls

- **Authentication Gate**: Mandatory Bearer token validation for all state-changing REST routes and WebSocket connection requests.
- **Standalone Session Isolation**: Standalone sessions run in isolated directories (`SESSION_RUNTIME_ROOT/<sessionId>`) and create zero directories in `WORKSPACE_ROOT`.
- **Database CHECK Invariants**: Strict constraints ensure `(session_type = 'standalone' AND project_id IS NULL) OR (session_type = 'project' AND project_id IS NOT NULL)`.
- **Structured Redaction**: Automated scrubbing of sensitive fields from structured application logs and outbound Discord messages.
- **Pre-Release Security Gate**: Repeatable local audit script (`scripts/security-check.sh`) verifying zero credential leakage, absence of private keys, and exclusion of runtime databases before code publication.
- **Test Isolation Harness**: Disposable test databases and dynamic ephemeral ports eliminate operational database pollution during automated test runs.
- **Process Lifecycle Governance**: Process table tracking (`processes` Map) ensuring `SIGTERM` and `SIGKILL` are issued on task cancellation or server shutdown, preventing orphaned child processes.
- **Discord Gateway Isolation & Egress Redaction**: Dedicated bridge running with default-deny guild/user allowlists, Hermes-style automatic channel discovery bounded by native Discord permissions (`ViewChannel`, `SendMessages`), originating-channel notification isolation, isolated interaction database (`bridge.db`), disabled direct messages, and automated scrubbing (`redactSensitive`) of credentials, internal IPs, and host paths before message dispatch. Detailed in [Discord Integration Guide](discord-integration.md).
- **Safe Git Execution & Injection Prevention**: All remote URLs and branches are strictly validated against character sets and prohibited prefixes (e.g. leading dashes preventing argument injection). Remote repository clones pass `--config core.hooksPath=/dev/null`, separate arguments after `--`, and enforce non-interactive terminal environment (`GIT_TERMINAL_PROMPT=0`). On clone failure, workspace directories are safely rolled back and purged to prevent leakage or corruption.

---

## Known Security Limitations

1. **Git Worktrees Are Not Sandboxes**: Git worktrees isolate version control branches, not system memory or system calls. Any process executed by an agent runs with the full system privileges of the daemon user.
2. **Regex Secret Redaction Is Defense-in-Depth**: While the orchestrator scrubs known header formats and tokens, pattern-based redaction cannot guarantee discovery of non-standard or obfuscated credentials.
3. **LLM Non-Determinism**: Autonomous auditors decrease hallucination risk through command execution, but cannot guarantee 100% bug detection in complex logic.

---

## Responsible Vulnerability Disclosure

If you discover a security vulnerability in Coding Orchestrator, please report it responsibly according to the guidelines in [SECURITY.md](../SECURITY.md). Do not file public GitHub issues for security vulnerabilities.
