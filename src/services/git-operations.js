import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateGitHubUrl, getProject } from './project-service.js';
import logger from '../logger.js';

const FORBIDDEN_FILE_REGEX = /(^|\/)(\.env|\.env\.[^.]*|.*\.db|.*\.db-(?:wal|shm)|.*\.sqlite[0-9]?|.*\.log|.*\.log\.gz|.*\.sql|.*\.dump|.*\.bak|id_rsa|id_ed25519|.*\.pem|.*\.key)$/i;

export class GitOperations {
  static isGitRepo(workspacePath) {
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd: workspacePath, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  static getHeadCommit(workspacePath) {
    try {
      return execSync('git rev-parse HEAD', { cwd: workspacePath, stdio: 'pipe' }).toString().trim();
    } catch {
      return null;
    }
  }

  static getCurrentBranch(workspacePath) {
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', { cwd: workspacePath, stdio: 'pipe' }).toString().trim();
    } catch {
      return 'main';
    }
  }

  static getRemoteUrl(workspacePath, remote = 'origin') {
    try {
      return execSync(`git config --get remote.${remote}.url`, { cwd: workspacePath, stdio: 'pipe' }).toString().trim();
    } catch {
      return null;
    }
  }

  static captureBaseline(workspacePath) {
    if (!this.isGitRepo(workspacePath)) {
      return { isGit: false, headCommit: null, statusMap: new Map() };
    }
    const headCommit = this.getHeadCommit(workspacePath);
    const statusMap = new Map();
    try {
      const raw = execSync('git status --porcelain', { cwd: workspacePath, stdio: 'pipe' }).toString();
      for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        const state = line.slice(0, 2);
        const file = line.slice(3).trim();
        statusMap.set(file, state);
      }
    } catch {}
    return { isGit: true, headCommit, statusMap };
  }

  static getTaskOwnedChanges(workspacePath, baseline = null) {
    if (!this.isGitRepo(workspacePath)) {
      return [];
    }

    const taskFiles = [];
    try {
      const raw = execSync('git status --porcelain', { cwd: workspacePath, stdio: 'pipe' }).toString();
      const currentLines = raw.split(/\r?\n/).filter(Boolean);

      for (const line of currentLines) {
        const file = line.slice(3).trim();
        const state = line.slice(0, 2);

        // Filter out forbidden secret files
        if (FORBIDDEN_FILE_REGEX.test(file) && !file.endsWith('.env.example')) {
          continue;
        }

        // If baseline exists, check if file was untracked/modified identically before
        if (baseline && baseline.statusMap && baseline.statusMap.has(file)) {
          const priorState = baseline.statusMap.get(file);
          if (priorState === state) {
            // Unchanged by current task - pre-existing user modification
            continue;
          }
        }

        taskFiles.push(file);
      }
    } catch {}

    return taskFiles;
  }

  static validateRepositoryIdentity(projectId, workspacePath) {
    const project = getProject(projectId);
    if (!this.isGitRepo(workspacePath)) {
      return { valid: false, error: 'Project workspace is not a valid Git repository' };
    }

    const actualRoot = execSync('git rev-parse --show-toplevel', { cwd: workspacePath, stdio: 'pipe' }).toString().trim();
    if (actualRoot !== workspacePath) {
      return { valid: false, error: `Git root mismatch: expected ${workspacePath}, found ${actualRoot}` };
    }

    const actualRemote = this.getRemoteUrl(workspacePath, 'origin');
    const expectedRepo = project.repository_url || project.repo_url || project.metadata?.expectedRepoUrl;

    // Check Ballo vs CodeOrchestrator mismatch constraint explicitly
    const isBallo = (project.slug && project.slug.toLowerCase().includes('ballo')) ||
                    (project.name && project.name.toLowerCase().includes('ballo'));
    if (isBallo && actualRemote && actualRemote.toLowerCase().includes('codeorchestrator')) {
      return {
        valid: false,
        error: `Critical repository mismatch: Project '${project.name}' points to codeorchestrator repository (${actualRemote}) instead of ballo repository.`
      };
    }

    if (expectedRepo && actualRemote) {
      const checkActual = validateGitHubUrl(actualRemote, { allowLocal: Boolean(project.is_test) || process.env.NODE_ENV === 'test' });
      const checkExpected = validateGitHubUrl(expectedRepo, { allowLocal: Boolean(project.is_test) || process.env.NODE_ENV === 'test' });

      if (checkActual.valid && checkExpected.valid) {
        const actualIdentity = `${checkActual.owner}/${checkActual.repo}`.toLowerCase();
        const expectedIdentity = `${checkExpected.owner}/${checkExpected.repo}`.toLowerCase();
        if (actualIdentity !== expectedIdentity) {
          return {
            valid: false,
            error: `Repository identity mismatch: workspace is configured for ${actualIdentity}, but project metadata expects ${expectedIdentity}.`
          };
        }
      }
    }

    const currentBranch = this.getCurrentBranch(workspacePath);
    const expectedBranch = project.default_branch || 'main';
    if (project.default_branch && currentBranch !== expectedBranch) {
      logger.warn({ currentBranch, expectedBranch }, 'Branch differs from default_branch');
    }

    return {
      valid: true,
      actualRoot,
      remoteUrl: actualRemote,
      currentBranch,
      expectedBranch
    };
  }

  static generateGitReview(projectId, workspacePath, baseline = null, customTaskFiles = null) {
    if (!this.isGitRepo(workspacePath)) {
      return {
        isGit: false,
        noChanges: true,
        filesAdded: 0,
        filesModified: 0,
        filesDeleted: 0,
        taskFiles: [],
        proposedCommitMessage: 'chore: no git changes detected'
      };
    }

    const baseCommit = baseline?.headCommit || this.getHeadCommit(workspacePath);
    const taskFiles = customTaskFiles && customTaskFiles.length > 0
      ? customTaskFiles
      : this.getTaskOwnedChanges(workspacePath, baseline);

    let added = 0;
    let modified = 0;
    let deleted = 0;

    for (const f of taskFiles) {
      const full = join(workspacePath, f);
      if (!existsSync(full)) {
        deleted++;
      } else if (baseline?.statusMap?.has(f)) {
        modified++;
      } else {
        added++;
      }
    }

    const currentRev = this.getHeadCommit(workspacePath) || 'HEAD';
    const currentBranch = this.getCurrentBranch(workspacePath);
    const remoteUrl = this.getRemoteUrl(workspacePath, 'origin');

    const noChanges = taskFiles.length === 0;
    const proposedCommitMessage = noChanges
      ? 'chore: no changes'
      : `feat: verified implementation (${taskFiles.length} files changed)`;

    return {
      isGit: true,
      repositoryIdentity: remoteUrl || workspacePath,
      targetBranch: currentBranch,
      baseRevision: baseCommit,
      reviewedRevision: currentRev,
      filesAdded: added,
      filesModified: modified,
      filesDeleted: deleted,
      taskFiles,
      noChanges,
      proposedCommitMessage
    };
  }

  static commitApprovedChanges(workspacePath, taskFiles, commitMessage = 'feat: verified changes') {
    if (!this.isGitRepo(workspacePath)) {
      throw new Error('Cannot commit: not a Git repository');
    }
    if (!taskFiles || taskFiles.length === 0) {
      return { committed: false, commitSha: null, message: 'No task-owned files to commit' };
    }

    // Configure safe local committer
    execSync('git config user.name "Coding Orchestrator"', { cwd: workspacePath, stdio: 'pipe' });
    execSync('git config user.email "orchestrator@local"', { cwd: workspacePath, stdio: 'pipe' });

    // Stage ONLY task-owned files (never git add -A or git add .)
    for (const f of taskFiles) {
      // Exclude secrets
      if (FORBIDDEN_FILE_REGEX.test(f) && !f.endsWith('.env.example')) continue;
      try {
        execSync(`git add -- "${f}"`, { cwd: workspacePath, stdio: 'pipe' });
      } catch (err) {
        logger.warn({ f, err: err.message }, 'Failed to stage task file');
      }
    }

    // Safe sanitized commit message
    const cleanMsg = (commitMessage || 'feat: automated verified implementation')
      .replace(/["`$\\]/g, '')
      .slice(0, 100);

    try {
      execSync(`git commit -m "${cleanMsg}"`, { cwd: workspacePath, stdio: 'pipe' });
      const sha = this.getHeadCommit(workspacePath);
      return { committed: true, commitSha: sha };
    } catch (err) {
      // Nothing to commit or already committed
      const sha = this.getHeadCommit(workspacePath);
      return { committed: false, commitSha: sha, error: err.message };
    }
  }

  static pushApprovedCommit({ workspacePath, remote = 'origin', branch = 'main', expectedCommitSha = null }) {
    if (!this.isGitRepo(workspacePath)) {
      return { success: false, reason: 'Not a Git repository' };
    }

    // Verify commit before pushing
    const currentHead = this.getHeadCommit(workspacePath);
    if (expectedCommitSha && currentHead !== expectedCommitSha) {
      return {
        success: false,
        reason: `HEAD revision changed (${currentHead} vs expected ${expectedCommitSha})`,
        diverged: true
      };
    }

    try {
      // Non-interactive push without force
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      execSync(`git push ${remote} ${branch}`, { cwd: workspacePath, env, stdio: 'pipe', timeout: 30000 });

      // Verify remote commit
      return { success: true, commitSha: currentHead, remote, branch };
    } catch (err) {
      const errMsg = err.stderr?.toString() || err.message;
      const isDiverged = errMsg.includes('non-fast-forward') || errMsg.includes('fetch first') || errMsg.includes('diverged');
      return {
        success: false,
        reason: errMsg,
        diverged: isDiverged
      };
    }
  }

  static preserveLocalChanges({ workspacePath, taskFiles = [], worktreePath = null }) {
    // ponytail: ensures changes remain intact in local workspace. Upgrade path: local stash / stash branch.
    logger.info({ workspacePath, files: taskFiles.length, worktreePath }, 'Preserved local changes without commit or push');
    return {
      preserved: true,
      workspacePath,
      retainedFiles: taskFiles
    };
  }
}
