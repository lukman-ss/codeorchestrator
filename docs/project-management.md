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

---

## Workspace Validation & Integrity Guards

To protect existing project checkouts from unintended execution or overwrites, CodeOrchestrator validates workspace Git configuration before executing tasks, multi-agent jobs, or creating project-scoped sessions.

### 1. Workspace Validation (`GET /projects/:id/validate`)

```bash
curl http://127.0.0.1:4000/projects/<PROJECT_ID>/validate \
  -H "Authorization: Bearer <TOKEN>"
```

Returns:
```json
{
  "valid": true,
  "actualRemote": "https://github.com/org/repo.git",
  "stack": "Node.js / JavaScript"
}
```

### 2. Critical Ballo Repository Protection

Project `ballo` has strict provenance enforcement:
- Intended repository: `https://github.com/lukman-ss/ballo` (Go).
- If the local checkout remote points to `codeorchestrator` or any non-Ballo repository, execution is blocked immediately with a descriptive error:
  `Repository mismatch detected: Project 'ballo' workspace remote is '...' but intended repository is 'https://github.com/lukman-ss/ballo' (Go). Execution blocked to protect workspace integrity. Explicit authorized correction required.`
- No local files are mutated or deleted during validation failure.

### 3. Safe Project Repair (`POST /projects/:id/repair`)

When workspace remotes or intended repository URLs change, project metadata can be repaired without deleting checkouts or silently altering remote configuration on disk:

```bash
curl -X POST http://127.0.0.1:4000/projects/<PROJECT_ID>/repair \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "repoUrl": "https://github.com/lukman-ss/ballo.git",
    "defaultBranch": "main",
    "confirm": true
  }'
```

- Requires `"confirm": true`.
- Updates database metadata record (`repository_url`, `default_branch`, `metadata.expectedRepoUrl`, `metadata.repairedAt`).
- Preserves the local filesystem checkout intact.

---

### 4. Repository Role Resolution & Scope Conflict Prevention

To prevent false repository mismatch blocks when specifications cite starter templates, framework dependencies, or documentation examples, CodeOrchestrator uses a domain-aware repository classifier and context resolver (`src/services/repository-classifier.js` and `src/services/project-context-resolver.js`).

#### Authority Precedence Hierarchy
1. **Server-side authorization and workspace security policy**.
2. **Explicit project selection** in the current request (`project: <slug>`).
3. **Registered project metadata and verified Git identity** on disk.
4. **Existing authorized session association** when continuing conversation.
5. **Specification repository-role interpretation** (extracting references without assuming they are target repos).

#### Repository Role Classification
Every Git URL mentioned in a prompt, markdown attachment, or directive is classified into a specific role:
- `TARGET`: Explicit destination repository requested for modifications (`repo: <url>`, `target repo: <url>`, `configure git remote <url>`).
- `STARTER`: Foundation or bootstrap template (e.g., `Ballo Starter sebagai fondasi: https://github.com/lukman-ss/ballo-starter`). Treated strictly as a read-only reference.
- `TEMPLATE`: Boilerplate or sample template. Read-only reference.
- `FRAMEWORK_DEPENDENCY`: Core framework dependencies (e.g., `https://github.com/lukman-ss/ballo`). Read-only reference.
- `LIBRARY_DEPENDENCY`: Go modules or npm packages (e.g., `go get github.com/...`).
- `DOCUMENTATION`: Reference guides and API docs.
- `EXAMPLE`: Demonstration or sample apps.
- `EXTERNAL_REFERENCE`: URLs within markdown code blocks, quotes, or unclassified body text.

#### Pre-Execution Scope Conflict Enforcement (`SCOPE_CONFLICT`)
If a specification explicitly directs modifications against an external repository (e.g., `modify repository directly: https://github.com/lukman-ss/ballo-starter.git`) while operating on a different registered project (e.g., `ballo-todo`), execution is immediately halted **before any task queueing, session creation, or file mutation**:
- **Status**: Rejected with `SCOPE_CONFLICT`.
- **Reason**: Shows target repository, requested repository, validation phase (`pre_execution_scope_check`), and recommended action.
- **Safety**: No workspace directories, files, or Git states are touched.

#### Canonical URL Normalization
All URL comparisons use canonical normalization (`normalizeGitUrl` / `areEquivalentGitUrls`) rather than raw string matching. HTTPS, SSH SCP (`git@github.com:...`), SSH URI (`ssh://git@github.com/...`), and SSH aliases (`git@github-coding:...`) for the same `owner/repo` resolve to identical canonical identities (`github.com/owner/repo`). Embedded credentials in URLs are rejected outright.

