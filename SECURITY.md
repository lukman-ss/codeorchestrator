# Security Policy

## Supported Versions

Only the latest release on the primary branch receives active security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

Please do not disclose security vulnerabilities through public GitHub issues or discussions.

To report a vulnerability:
1. Email your findings to `security@orchestrator.local` (or file a private GitHub Security Advisory once configured).
2. Include reproduction steps, impacted components, and potential exploit vectors.
3. Allow up to 48 hours for initial triage and confirmation.
4. Maintain confidentiality until a patch or mitigation is publicly released.

## Security Architecture

- **Token Authentication**: All HTTP and WebSocket requests require `Authorization: Bearer <ORCHESTRATOR_API_TOKEN>`.
- **Path Traversal Protection**: Project creation and workspace slug generation strictly validate workspace paths to prevent traversal outside configured roots.
- **Credential Storage**: Database records store metadata only. API keys and operational tokens are ingested via environment variables and never logged or written to disk.
- **Git Worktree Isolation**: Independent agent tasks execute in isolated Git worktrees to prevent collision on dirty working states.
