# Project Management

Coding Orchestrator manages persistent codebase workspaces located in `WORKSPACE_ROOT`. Each project maps to a dedicated directory and Git repository.

## Project Identification

- **Project ID**: Cryptographic UUID (`randomUUID()`) assigned at creation.
- **Slug**: Unique URL-friendly string matching regex `^[a-z0-9-]+$`.
- **Workspace Path**: Canonical filesystem location: `${WORKSPACE_ROOT}/${slug}`.

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

The orchestrator creates the directory `${WORKSPACE_ROOT}/backend-service` and records the project in SQLite.

### 2. Clone from Remote Git Repository

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

### 3. Register Existing Workspace Directory (Import)

If code already exists in `${WORKSPACE_ROOT}/<slug>`, register it via `/projects/import`:

```bash
curl -X POST http://127.0.0.1:4000/projects/import \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "existing-repo"
  }'
```

If already registered, the orchestrator returns the existing project record without duplicating rows.

## Modifying Project Settings

Update project name or default LLM model:

```bash
curl -X PATCH http://127.0.0.1:4000/projects/<PROJECT_ID> \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Backend Name",
    "defaultModel": "9router/claude-3-5-sonnet"
  }'
```

## Listing Projects & Inspecting Associated Work

```bash
# List all registered projects
curl -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:4000/projects

# Get specific project details
curl -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:4000/projects/<PROJECT_ID>

# List all tasks executed for a project
curl -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:4000/projects/<PROJECT_ID>/tasks

# List all sessions created for a project
curl -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:4000/projects/<PROJECT_ID>/sessions
```
