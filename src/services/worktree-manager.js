import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_WORKTREE_ROOT } from '../config.js';
import logger from '../logger.js';

export class WorktreeManager {
  static getWorktreeBase(projectSlug, jobId) {
    return join(AGENT_WORKTREE_ROOT, projectSlug, jobId);
  }

  static getWorktreePath(projectSlug, jobId, subtaskId) {
    return join(this.getWorktreeBase(projectSlug, jobId), `worker-${subtaskId}`);
  }

  static isGitRepo(dirPath) {
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd: dirPath, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  static ensureGitInit(canonicalPath) {
    if (!this.isGitRepo(canonicalPath)) {
      execSync('git init', { cwd: canonicalPath, stdio: 'pipe' });
      execSync('git config user.name "Coding Orchestrator"', { cwd: canonicalPath, stdio: 'pipe' });
      execSync('git config user.email "orchestrator@local"', { cwd: canonicalPath, stdio: 'pipe' });
      execSync('git add -A', { cwd: canonicalPath, stdio: 'pipe' });
      try {
        execSync('git commit -m "chore: initial commit by orchestrator"', { cwd: canonicalPath, stdio: 'pipe' });
      } catch {}
    }
  }

  static createWorkerWorktree({ canonicalPath, projectSlug, jobId, subtaskId }) {
    if (!this.isGitRepo(canonicalPath)) {
      return { path: canonicalPath, branch: null, isWorktree: false };
    }

    const worktreePath = this.getWorktreePath(projectSlug, jobId, subtaskId);
    const branchName = `agent/${jobId}/${subtaskId}`;

    if (existsSync(worktreePath)) {
      return { path: worktreePath, branch: branchName, isWorktree: true };
    }

    mkdirSync(join(AGENT_WORKTREE_ROOT, projectSlug, jobId), { recursive: true });

    try {
      execSync(`git branch -D ${branchName} 2>/dev/null || true`, { cwd: canonicalPath, stdio: 'pipe' });
      execSync(`git worktree add -B ${branchName} "${worktreePath}" HEAD`, { cwd: canonicalPath, stdio: 'pipe' });
      logger.info({ projectSlug, jobId, subtaskId, worktreePath }, 'Created git worktree');
      return { path: worktreePath, branch: branchName, isWorktree: true };
    } catch (err) {
      logger.error({ err, projectSlug, jobId, subtaskId }, 'Failed to create git worktree');
      throw err;
    }
  }

  static cleanupWorktree(canonicalPath, worktreePath, branchName) {
    try {
      if (existsSync(worktreePath)) {
        execSync(`git worktree remove --force "${worktreePath}"`, { cwd: canonicalPath, stdio: 'pipe' });
      }
      if (branchName) {
        execSync(`git branch -D "${branchName}"`, { cwd: canonicalPath, stdio: 'pipe' });
      }
    } catch (err) {
      logger.warn({ err, worktreePath }, 'Failed to cleanup worktree');
    }
  }

  static getHeadRevision(dirPath) {
    try {
      return execSync('git rev-parse HEAD', { cwd: dirPath, stdio: 'pipe' }).toString().trim();
    } catch {
      return 'rev-' + Date.now();
    }
  }
}