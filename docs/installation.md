# Installation Guide

## System Requirements

- **CPU**: 2+ vCPUs recommended for multi-agent workloads.
- **RAM**: Minimum 4 GB RAM (8+ GB recommended when running concurrent OpenCode subprocesses).
- **Disk**: Minimum 10 GB free disk space. The service automatically blocks task execution when free space falls below `MIN_FREE_DISK_MB` (default 2048 MB) or disk usage exceeds `MAX_DISK_USAGE_PERCENT` (default 90%).
- **OS**: Linux (Debian 13 / Ubuntu 24.04).

## 1. System Packages

On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y curl git build-essential python3
```

## 2. Install Node.js 24

Install Node.js 24 using NodeSource or your preferred version manager:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v # Should output v24.x.x
```

## 3. Install OpenCode

Coding Orchestrator coordinates coding tasks by invoking `opencode`:

```bash
npm install -g opencode
# Verify opencode is in PATH
which opencode
```

## 4. Repository Setup

```bash
cd /opt # or your designated service directory
git clone <REPOSITORY_URL> coding-orchestrator
cd coding-orchestrator
npm ci
```

## 5. Directory Structure & Permissions

The orchestrator creates workspace directories and databases at runtime:

```bash
# Ensure runtime data and logs directories are writable
mkdir -p data logs workspace .agent-worktrees
```

Review [Configuration](configuration.md) and [Deployment](deployment.md) for production service setup.
