# Getting Started

This guide explains how to install, configure, and execute your first coding tasks with Coding Orchestrator.

## Prerequisites

- **Operating System**: Linux (Debian 12/13, Ubuntu 22.04/24.04 recommended).
- **Node.js**: Node.js 24.x LTS (ESM modules supported natively).
- **Git**: Git 2.30+ installed and configured with `user.name` and `user.email`.
- **OpenCode**: Installed globally or locally accessible in your PATH.
- **SQLite**: Better-sqlite3 native compilation toolchain (`python3`, `make`, `g++`).

## Quick Start in 5 Minutes

### 1. Clone & Install Dependencies

```bash
git clone <REPOSITORY_URL> coding-orchestrator
cd coding-orchestrator
npm ci
```

### 2. Configure Environment

Copy the provided example environment template:

```bash
cp .env.example .env
```

Edit `.env` to configure your API authentication token and LLM provider credentials:

```ini
PORT=4000
HOST=127.0.0.1
REQUIRE_AUTH=true
ORCHESTRATOR_API_TOKEN=generate-a-secure-random-token-here

NINEROUTER_API_KEY=your-actual-llm-gateway-key
DEFAULT_MODEL=9router/ayce-combo
```

### 3. Verify Local Security Gates

Run the local security gate to ensure no credentials or forbidden patterns are exposed:

```bash
npm run security-check # or bash scripts/security-check.sh
```

### 4. Run Automated Tests

Execute the built-in Node.js test suite:

```bash
npm test
```

### 5. Start the Server

```bash
npm start
```

Verify service readiness in another terminal:

```bash
curl -H "Authorization: Bearer <YOUR_TOKEN>" http://127.0.0.1:4000/health
```

Expected response:

```json
{
  "status": "ok",
  "pid": 12345,
  "globalRunning": 0,
  "queueDepth": 0,
  "diskFreeMB": 24000,
  "diskUsagePercent": 18,
  "diskThresholdMB": 2048
}
```

Next steps: See [API Reference](api-reference.md) and [Task Lifecycle](task-lifecycle.md).
