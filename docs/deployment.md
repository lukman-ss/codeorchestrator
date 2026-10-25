# Deployment Guide

This guide details best practices for deploying Coding Orchestrator in production environments using systemd, secure environment management, and reverse proxy architectures.

## 1. Systemd User Service Setup

Running as a systemd user service isolates execution to an unprivileged service account without requiring root privileges.

### Unit File Location

Create or copy the service definition to:

`~/.config/systemd/user/coding-orchestrator.service`

### Service Unit Template

```ini
[Unit]
Description=Coding Orchestrator
Documentation=https://github.com/anomalyco/opencode
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/coding-orchestrator
ExecStart=/usr/bin/node src/server.js
EnvironmentFile=%h/coding-orchestrator/.env
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
LimitNOFILE=65535

# Process Hardening
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

### Enable and Start Service

```bash
# Reload systemd user daemon
systemctl --user daemon-reload

# Enable service to boot automatically on reboot
systemctl --user enable coding-orchestrator

# Start service
systemctl --user start coding-orchestrator

# Inspect service status
systemctl --user status coding-orchestrator
```

To ensure user services persist after logout, enable lingering for the service account:

```bash
sudo loginctl enable-linger $USER
```

---

## 2. Environment Configuration Security

- Always store secrets in `.env` located inside the application directory.
- Restrict file permissions so only the owner can read it:
  ```bash
  chmod 600 .env
  ```
- Ensure `.env` is never added to Git commits (enforced by `.gitignore`).

---

## 3. Reverse Proxy & TLS Hardening

The orchestrator listens on `127.0.0.1:4000` by default. **Never bind the orchestrator directly to public network interfaces (`0.0.0.0`).**

When remote access is needed, terminate TLS using Caddy or Nginx.

### Example Caddyfile (WebSocket & REST with TLS)

```caddy
orchestrator.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

Caddy automatically handles WebSocket upgrade headers and provisions Let's Encrypt TLS certificates.

---

## 4. Backup & Disaster Recovery

### What to Back Up:
1. **SQLite Database**: `data/orchestrator.db`
2. **Environment Configuration**: `.env`
3. **Canonical Workspaces**: `~/workspace/`

### Safe SQLite Backup:
Because SQLite is in WAL mode, do not copy the raw database while writes are occurring. Use SQLite's online backup API or CLI tool:

```bash
sqlite3 data/orchestrator.db ".backup 'data/backup-$(date +%Y%m%d).db'"
```
