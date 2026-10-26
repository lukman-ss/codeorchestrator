# Project Management

Coding Orchestrator manages persistent codebase workspaces located in `WORKSPACE_ROOT`. Each project maps to a dedicated directory and Git repository.

## Project Identification & Provenance

- **Project ID**: Cryptographic UUID (`randomUUID()`) assigned at creation.
- **Slug**: Unique URL-friendly string matching regex `^[a-z0-9-]+$`.
- **Workspace Path**: Canonical filesystem location: `${WORKSPACE_ROOT}/${slug}`.
- **Provenance Marker (`is_test`)**: An integer flag (`0` or `1`) distinguishing real production projects from test/integration runs.

## Creating a Project

### 1. Initialize an Empty Project

```bash
curl -X POST http://127.0.0.1:4000/projects \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Backend Service",
    "slug": "backend-service",
    "defaultModel": "9router/ayce-combo"
  }'
```

The orchestrator creates the directory `${WORKSPACE_ROOT}/backend-service` and records the project in SQLite with `is_test = 0`.

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

### 3. Clone from Remote Git Repository

When `repoUrl` is supplied, the orchestrator validates the URL and executes `git clone`:

```bash
curl -X POST http://127.0.0.1:4000/projects \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Frontend Web App",
    "slug": "frontend-webapp",
    "repoUrl": "https://github.com/example/frontend.git",
    "defaultModel": "9router/ayce-combo"
  }'
```

*Note*: If `git clone` fails, the orchestrator performs an automatic cleanup of the failed workspace directory and returns an HTTP 400 error.

### 4. Register Existing Workspace Directory (Import)

If code already exists in `${WORKSPACE_ROOT}/<slug>`, register it via `/projects/import`:

```bash
curl -X POST http://127.0.0.1:4000/projects/import \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "existing-repo"
  }'
```

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
