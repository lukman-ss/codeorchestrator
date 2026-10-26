# Project Management

Coding Orchestrator manages persistent codebase workspaces located in `WORKSPACE_ROOT`. Each project maps to a dedicated directory and Git repository.

## Project Identification & Provenance

- **Project ID**: Cryptographic UUID (`randomUUID()`) assigned at creation.
- **Slug**: Unique URL-friendly string matching regex `^[a-z0-9-]+$`.
- **Workspace Path**: Canonical filesystem location: `${WORKSPACE_ROOT}/${slug}`.
- **Provenance Marker (`is_test`)**: An integer flag (`0` or `1`) distinguishing real production projects from test/integration runs.

## Creating a Project

### 1. Initialize an Empty Project (Mode A)

Initializes a new empty directory in `WORKSPACE_ROOT` with `git init` (branch `main`):

```bash
curl -X POST http://127.0.0.1:4000/projects \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Backend Service",
    "description": "Core backend API service",
    "defaultModel": "9router/ayce-combo",
    "initGit": true
  }'
```

The orchestrator creates `${WORKSPACE_ROOT}/backend-service`, initializes a clean git repository on branch `main`, and records the project with `is_test = 0`.

### 2. Creating a Test Project

Pass `isTest: true` or header `x-test-mode: true` to mark the project as a test artifact:

```bash
curl -X POST http://127.0.0.1:4000/projects \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Run Project",
    "slug": "test-run-123",
    "isTest": true
  }'
```

### 3. Clone from Remote Git Repository (Mode B)

When `repoUrl` is supplied, the orchestrator validates the GitHub repository URL and executes a non-interactive clone (`GIT_TERMINAL_PROMPT=0`, `--config core.hooksPath=/dev/null`):

Supported URL formats:
- HTTPS: `https://github.com/org/repo.git` (or without `.git`)
- SSH: `git@github.com:org/repo.git` or `ssh://git@github.com/org/repo.git`
- SSH Alias: `git@github-coding:org/repo.git` (using configured SSH identity `~/.ssh/id_ed25519_coding_orchestrator`)

```bash
curl -X POST http://127.0.0.1:4000/projects \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Frontend Web App",
    "repoUrl": "git@github-coding:org/frontend.git",
    "branch": "develop",
    "defaultModel": "9router/ayce-combo"
  }'
```

*Safety & Cleanup*: If `git clone` fails, the orchestrator automatically purges the allocated workspace directory, prevents orphaned files, and reports the sanitized error.

### 4. Asynchronous Project Creation & Operations

For slow operations (e.g. cloning large repositories), pass `"async": true` to receive HTTP `202 Accepted` with an `operationId`:

```bash
curl -X POST http://127.0.0.1:4000/projects \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Large Service",
    "repoUrl": "https://github.com/org/large-service.git",
    "async": true
  }'
```

Response:
```json
{
  "operationId": "op-4f81c964-b04f-4a0e-9149-14a8be41398c",
  "status": "pending",
  "pollUrl": "/projects/operations/op-4f81c964-b04f-4a0e-9149-14a8be41398c"
}
```

Track status via `GET /projects/operations/:id`. Status transitions:
`pending` -> `validating` -> `creating` -> `cloning` -> `registering` -> `completed` (or `failed`).
If the orchestrator server crashes or restarts during an in-flight operation, `recoverOperations()` marks pending tasks as `failed` to prevent hung states.

### 5. Register Existing Workspace Directory (Import)

If an unmanaged directory already exists under `WORKSPACE_ROOT`, register it with automatic stack detection and git remote extraction:

```bash
curl -X POST http://127.0.0.1:4000/projects/import \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "directory": "existing-service",
    "name": "Existing Service Display Name"
  }'
```

Stack detection inspects root markers (e.g. `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Dockerfile`) and git remotes (`origin`) automatically. This operation is idempotent.

---

## Listing Projects

By default, `GET /projects` only returns operational projects (`is_test = 0`):

```bash
# Returns only production projects
curl http://127.0.0.1:4000/projects -H "Authorization: Bearer <TOKEN>"

# Include test projects for maintenance or audit
curl "http://127.0.0.1:4000/projects?includeTest=true" -H "Authorization: Bearer <TOKEN>"
```

---

## Project-Linked Sessions

To create an interactive session scoped to a project workspace:

```bash
curl -X POST http://127.0.0.1:4000/projects/<PROJECT_ID>/sessions \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Bug Fix Session",
    "model": "9router/ayce-combo"
  }'
```

To list sessions attached to a specific project:

```bash
curl http://127.0.0.1:4000/projects/<PROJECT_ID>/sessions \
  -H "Authorization: Bearer <TOKEN>"
```
