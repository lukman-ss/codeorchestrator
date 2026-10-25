# Git Worktree Isolation

Coding Orchestrator leverages native Git worktrees (`git worktree`) to isolate code modifications produced by concurrent worker agents.

## How Worktrees Work in the Orchestrator

When a project is backed by a Git repository, the `WorktreeManager` (`src/services/worktree-manager.js`) provisions a dedicated worktree directory for each worker subtask.

```
<AGENT_WORKTREE_ROOT>/
└── <projectSlug>/
    └── <jobId>/
        ├── worker-<subtaskId_1>/   (Branch: agent/<jobId>/<subtaskId_1>)
        ├── worker-<subtaskId_2>/   (Branch: agent/<jobId>/<subtaskId_2>)
        └── worker-<subtaskId_3>/   (Branch: agent/<jobId>/<subtaskId_3>)
```

### Lifecycle:

1. **Worktree Creation**:
   ```bash
   git worktree add -B agent/<jobId>/<subtaskId> <worktreePath> HEAD
   ```
2. **Worker Execution**: The Worker OpenCode process is spawned with `cwd: <worktreePath>`. All file edits, test creations, and scratch files are written to this isolated directory.
3. **Auditing**: The Auditor inspects the worktree in place before any code touches the main branch.
4. **Integration**: If verified, the Integration agent merges the branch into canonical `HEAD`.
5. **Worktree Cleanup**:
   ```bash
   git worktree remove --force <worktreePath>
   git branch -D agent/<jobId>/<subtaskId>
   ```

---

## CRITICAL SECURITY NOTICE: Worktrees Are NOT OS Sandboxes

**A Git worktree is a filesystem and version control convenience, NOT a security boundary.**

- **Shared Host OS**: Subprocesses running in a worktree execute with the exact same OS user permissions as the orchestrator daemon.
- **Process Visibility**: Subprocesses can inspect running processes, read system files, and access environment variables unless constrained at the OS level.
- **Filesystem Traversal**: Malicious code or injected prompts can issue commands (such as `cat /etc/passwd` or `rm -rf ~`) that escape the worktree directory.
- **Network Access**: Processes can open outbound network sockets unless blocked by network namespaces or firewall rules.

### Production Hardening Recommendations:

To achieve true execution containment:
1. Run Coding Orchestrator inside a dedicated unprivileged Linux user account.
2. Deploy within disposable containers (Docker / Podman / rootless Podman) or lightweight microVMs (Firecracker / gVisor).
3. Restrict outbound egress networking using Tailscale ACLs or Linux iptables/nftables.
