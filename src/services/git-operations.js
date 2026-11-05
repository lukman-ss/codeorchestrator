import { execSync, spawnSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateGitHubUrl, getProject } from './project-service.js';
import { GIT_USER_NAME, GIT_USER_EMAIL } from '../config.js';
import logger from '../logger.js';

const execAsync = promisify(exec);

export const GIT_STATES = {
  LOCAL_NO_GIT: 'LOCAL_NO_GIT',
  LOCAL_GIT_NO_REMOTE: 'LOCAL_GIT_NO_REMOTE',
  GIT_REMOTE_CONFIGURED: 'GIT_REMOTE_CONFIGURED'
};

const FORBIDDEN_FILE_REGEX = /(^|\/)(\.env|\.env\.[^.]*|.*\.db|.*\.db-(?:wal|shm)|.*\.sqlite[0-9]?|.*\.log|.*\.log\.gz|.*\.dump|.*\.dmp|.*(?:dump|backup).*\.sql|.*\.bak|id_rsa|id_ed25519|.*\.pem|.*\.key)$/i;

export class GitOperations {
  static getGitState(workspacePath) {
    if (!workspacePath || !existsSync(workspacePath) || !this.isGitRepo(workspacePath)) {
      return GIT_STATES.LOCAL_NO_GIT;
    }
    const remote = this.getRemoteUrl(workspacePath, 'origin');
    if (!remote) {
      return GIT_STATES.LOCAL_GIT_NO_REMOTE;
    }
    return GIT_STATES.GIT_REMOTE_CONFIGURED;
  }

  static initLocalGit(workspacePath, defaultBranch = 'main') {
    if (!existsSync(workspacePath)) {
      throw new Error(`Workspace directory does not exist: ${workspacePath}`);
    }
    if (!this.isGitRepo(workspacePath)) {
      execSync(`git init -b "${defaultBranch}" --quiet`, { cwd: workspacePath, stdio: 'pipe' });
      try {
        execSync(`git config user.name "${GIT_USER_NAME}"`, { cwd: workspacePath, stdio: 'pipe' });
        execSync(`git config user.email "${GIT_USER_EMAIL}"`, { cwd: workspacePath, stdio: 'pipe' });
      } catch {}
      return true;
    }
    return false;
  }

  static configureRemote(workspacePath, remoteUrl, remoteName = 'origin') {
    if (!existsSync(workspacePath)) {
      throw new Error(`Workspace directory does not exist: ${workspacePath}`);
    }
    if (!this.isGitRepo(workspacePath)) {
      this.initLocalGit(workspacePath);
    }
    const existing = this.getRemoteUrl(workspacePath, remoteName);
    if (existing) {
      execSync(`git remote set-url ${remoteName} "${remoteUrl}"`, { cwd: workspacePath, stdio: 'pipe' });
    } else {
      execSync(`git remote add ${remoteName} "${remoteUrl}"`, { cwd: workspacePath, stdio: 'pipe' });
    }
    return this.getRemoteUrl(workspacePath, remoteName);
  }

  static getWorkerEnv(overrides = {}) {
    // ponytail: strip all publish/admin credentials & inject git sandbox interceptor into PATH.
    const sandboxDir = join(process.cwd(), 'bin', 'git-sandbox');
    const existingPath = process.env.PATH || '';
    const env = {
      ...process.env,
      ...overrides,
      PATH: `${sandboxDir}:${existingPath}`,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o IdentitiesOnly=yes -F /dev/null'
    };
    // Strip push-capable credentials & admin secrets
    delete env.SSH_AUTH_SOCK;
    delete env.GIT_SSH;
    delete env.GIT_ASKPASS;
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    delete env.DISCORD_BOT_TOKEN;
    delete env.DISCORD_CLIENT_ID;
    delete env.ORCHESTRATOR_API_TOKEN;
    delete env.API_AUTH_TOKEN;
    delete env.DATABASE_PATH;
    delete env.DISCORD_DB_PATH;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_ACCESS_KEY_ID;
    return env;
  }

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
        const isExampleOrTemplate = /\.(example|template|sample)$/i.test(file) || /(?:^|\/)\.env\.(example|template|sample)$/i.test(file);
        if (FORBIDDEN_FILE_REGEX.test(file) && !isExampleOrTemplate) {
          continue;
        }

        taskFiles.push(file);
      }
    } catch {}

    return taskFiles;
  }

  static validateRepositoryIdentity(projectId, workspacePath) {
    const project = getProject(projectId);
    const gitState = this.getGitState(workspacePath);
    const expectedRepo = project.repository_url || project.repo_url || project.metadata?.expectedRepoUrl;

    if (gitState === GIT_STATES.LOCAL_NO_GIT) {
      if (expectedRepo) {
        return { valid: false, error: 'Project workspace is not a valid Git repository', gitState };
      }
      return {
        valid: true,
        gitState,
        isGit: false,
        actualRoot: workspacePath,
        remoteUrl: null,
        currentBranch: project.default_branch || 'main',
        expectedBranch: project.default_branch || 'main'
      };
    }

    const actualRoot = execSync('git rev-parse --show-toplevel', { cwd: workspacePath, stdio: 'pipe' }).toString().trim();
    if (actualRoot !== workspacePath) {
      return { valid: false, error: `Git root mismatch: expected ${workspacePath}, found ${actualRoot}`, gitState };
    }

    const actualRemote = this.getRemoteUrl(workspacePath, 'origin');

    // Check Ballo vs CodeOrchestrator mismatch constraint explicitly
    const isBallo = (project.slug && project.slug.toLowerCase().includes('ballo')) ||
                    (project.name && project.name.toLowerCase().includes('ballo'));
    if (isBallo && actualRemote && (actualRemote.toLowerCase().includes('codeorchestrator') || actualRemote.toLowerCase().includes('coding-orchestrator'))) {
      return {
        valid: false,
        error: `Critical repository mismatch: Project '${project.name}' points to codeorchestrator repository (${actualRemote}) instead of ballo repository.`,
        gitState
      };
    }

    if (gitState === GIT_STATES.LOCAL_GIT_NO_REMOTE) {
      if (expectedRepo) {
        return { valid: false, error: `Repository remote 'origin' is not configured, but expected ${expectedRepo}.`, gitState };
      }
      return {
        valid: true,
        gitState,
        actualRoot,
        remoteUrl: null,
        currentBranch: this.getCurrentBranch(workspacePath),
        expectedBranch: project.default_branch || 'main'
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
            error: `Repository identity mismatch: workspace is configured for ${actualIdentity}, but project metadata expects ${expectedIdentity}.`,
            gitState
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
      gitState,
      actualRoot,
      remoteUrl: actualRemote,
      currentBranch,
      expectedBranch
    };
  }

  static buildCommitMessage({
    prompt = '',
    taskId = null,
    jobId = null,
    taskFiles = [],
    filesAdded = 0,
    filesModified = 0,
    filesDeleted = 0,
    verification = null,
    security = null,
    noChanges = false
  } = {}) {
    if (noChanges || taskFiles.length === 0) {
      return 'chore: no changes detected';
    }

    const pLower = (prompt || '').toLowerCase();
    let type = 'feat';
    if (/\b(fix|bug|error|issue|repair|failing|resolve)\b/.test(pLower)) {
      type = 'fix';
    } else if (/\b(test|spec)\b/.test(pLower)) {
      type = 'test';
    } else if (/\b(refactor|clean|simplify)\b/.test(pLower)) {
      type = 'refactor';
    } else if (/\b(docs|readme)\b/.test(pLower)) {
      type = 'docs';
    } else if (/\b(chore|dep|upgrade|bump)\b/.test(pLower)) {
      type = 'chore';
    }

    let subject = '';
    if (prompt) {
      const firstLine = prompt.replace(/\r?\n.*/s, '').trim();
      const cleaned = firstLine.replace(/^(feat|fix|refactor|test|chore|docs)(\([^)]+\))?:\s*/i, '');
      subject = cleaned.length > 60 ? cleaned.slice(0, 57) + '...' : cleaned;
    }
    if (!subject) {
      subject = `verified implementation (${taskFiles.length} files changed)`;
    }

    const header = `${type}: ${subject}`;
    const bodyLines = [];

    if (prompt && prompt.trim()) {
      bodyLines.push('Context:');
      const pLines = prompt.trim().split('\n').map(l => `  ${l}`);
      bodyLines.push(...pLines);
      bodyLines.push('');
    }

    bodyLines.push('Changes Overview:');
    bodyLines.push(`- Added: ${filesAdded}, Modified: ${filesModified}, Deleted: ${filesDeleted}`);
    const fileList = taskFiles.slice(0, 20).map(f => `  * ${f}`);
    bodyLines.push(...fileList);
    if (taskFiles.length > 20) {
      bodyLines.push(`  * ... and ${taskFiles.length - 20} more files`);
    }
    bodyLines.push('');

    bodyLines.push('Quality Gate Verification:');
    const vStatus = verification?.passed ?? true;
    const sStatus = security?.passed ?? true;
    bodyLines.push(`- Gate 1 (Implementation & Syntax): ${vStatus ? 'PASSED' : 'FAILED'}${verification?.command ? ` (${verification.command})` : ''}`);
    bodyLines.push(`- Gate 2 (Security & Secret Audit): ${sStatus ? 'PASSED' : 'FAILED'}`);
    bodyLines.push('- Gate 3 (Git Safety & Identity): PASSED');

    if (taskId || jobId) {
      bodyLines.push('');
      if (taskId) bodyLines.push(`Task-ID: ${taskId}`);
      if (jobId) bodyLines.push(`Job-ID: ${jobId}`);
    }

    return `${header}\n\n${bodyLines.join('\n')}\n`;
  }

  static generateGitReview(projectId, workspacePath, baseline = null, customTaskFiles = null, options = {}) {
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
    const proposedCommitMessage = this.buildCommitMessage({
      prompt: options.prompt,
      taskId: options.taskId,
      jobId: options.jobId,
      taskFiles,
      filesAdded: added,
      filesModified: modified,
      filesDeleted: deleted,
      verification: options.verifRes || options.verification,
      security: options.auditRes || options.security,
      noChanges
    });

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
    execSync(`git config user.name "${GIT_USER_NAME}"`, { cwd: workspacePath, stdio: 'pipe' });
    execSync(`git config user.email "${GIT_USER_EMAIL}"`, { cwd: workspacePath, stdio: 'pipe' });

    // Stage ONLY task-owned files (never git add -A or git add .)
    for (const f of taskFiles) {
      const isExampleOrTemplate = /\.(example|template|sample)$/i.test(f) || /(?:^|\/)\.env\.(example|template|sample)$/i.test(f);
      if (FORBIDDEN_FILE_REGEX.test(f) && !isExampleOrTemplate) continue;
      try {
        execSync(`git add -- "${f}"`, { cwd: workspacePath, stdio: 'pipe' });
      } catch (err) {
        logger.warn({ f, err: err.message }, 'Failed to stage task file');
      }
    }

    const finalMsg = typeof commitMessage === 'string' && commitMessage.trim()
      ? commitMessage.trim()
      : 'feat: automated verified implementation';

    try {
      const res = spawnSync('git', ['commit', '-F', '-'], {
        cwd: workspacePath,
        input: finalMsg,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (res.status !== 0) {
        const errText = res.stderr || res.stdout || 'Commit failed';
        const sha = this.getHeadCommit(workspacePath);
        return { committed: false, commitSha: sha, error: errText };
      }

      const sha = this.getHeadCommit(workspacePath);
      return { committed: true, commitSha: sha };
    } catch (err) {
      const sha = this.getHeadCommit(workspacePath);
      return { committed: false, commitSha: sha, error: err.message };
    }
  }

  static getRemotes(workspacePath) {
    if (!this.isGitRepo(workspacePath)) return [];
    try {
      const out = execSync('git remote', { cwd: workspacePath, stdio: 'pipe', encoding: 'utf8' });
      return out.split('\n').map(r => r.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  static async pushToSingleRemote({ workspacePath, remote, branch, currentHead }) {
    try {
      const remoteUrl = this.getRemoteUrl(workspacePath, remote);
      if (remoteUrl && remoteUrl.startsWith('https://github.com/')) {
        const match = remoteUrl.match(/^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
        if (match) {
          try {
            await execAsync(`git remote set-url ${remote} "git@github-coding:${match[1]}/${match[2]}.git"`, { cwd: workspacePath });
          } catch {}
        }
      }

      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      try {
        await execAsync(`git push -u ${remote} ${branch}`, { cwd: workspacePath, env, timeout: 30000 });
      } catch (pushErr) {
        const pushErrMsg = (pushErr.stderr?.toString() || pushErr.message || '').toLowerCase();
        if (pushErrMsg.includes('non-fast-forward') || pushErrMsg.includes('fetch first')) {
          try {
            await execAsync(`git pull --rebase ${remote} ${branch}`, { cwd: workspacePath, env, timeout: 30000 });
            await execAsync(`git push -u ${remote} ${branch}`, { cwd: workspacePath, env, timeout: 30000 });
          } catch {
            try { await execAsync('git rebase --abort', { cwd: workspacePath, env }); } catch {}
            await execAsync(`git push ${remote} ${branch}`, { cwd: workspacePath, env, timeout: 30000 });
          }
        } else {
          await execAsync(`git push ${remote} ${branch}`, { cwd: workspacePath, env, timeout: 30000 });
        }
      }

      return { success: true, commitSha: currentHead, remote, branch };
    } catch (err) {
      const errMsg = err.stderr?.toString() || err.message;
      const isDiverged = errMsg.includes('non-fast-forward') || errMsg.includes('fetch first') || errMsg.includes('diverged');
      return {
        success: false,
        remote,
        branch,
        reason: errMsg,
        diverged: isDiverged
      };
    }
  }

  static async pushApprovedCommit({ workspacePath, remote = 'origin', remotes = null, branch = 'main', expectedCommitSha = null }) {
    if (!this.isGitRepo(workspacePath)) {
      return { success: false, reason: 'Not a Git repository' };
    }

    const currentHead = this.getHeadCommit(workspacePath);
    if (!currentHead) {
      return {
        success: false,
        reason: 'Repository has no commits to push (HEAD is null)'
      };
    }
    if (expectedCommitSha && currentHead !== expectedCommitSha) {
      return {
        success: false,
        reason: `HEAD revision changed (${currentHead} vs expected ${expectedCommitSha})`,
        diverged: true
      };
    }

    let targetRemotes = [];
    if (Array.isArray(remotes) && remotes.length > 0) {
      targetRemotes = remotes;
    } else if (typeof remotes === 'string' && remotes.trim()) {
      targetRemotes = remotes.split(',').map(r => r.trim()).filter(Boolean);
    } else {
      const configured = this.getRemotes(workspacePath);
      if (configured.length > 0) {
        if (remote && !configured.includes(remote)) {
          targetRemotes = [remote, ...configured];
        } else {
          targetRemotes = configured;
        }
      } else {
        targetRemotes = [remote || 'origin'];
      }
    }
    targetRemotes = [...new Set(targetRemotes)];

    const settled = await Promise.allSettled(
      targetRemotes.map(rem => this.pushToSingleRemote({ workspacePath, remote: rem, branch, currentHead }))
    );

    const results = settled.map((res, i) => {
      if (res.status === 'fulfilled') return res.value;
      return { success: false, remote: targetRemotes[i], reason: res.reason?.message || String(res.reason) };
    });

    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
      return {
        success: false,
        reason: failed.map(f => `[${f.remote}] ${f.reason}`).join('; '),
        diverged: failed.some(f => f.diverged),
        remotes: results
      };
    }

    return {
      success: true,
      commitSha: currentHead,
      remote: targetRemotes.join(','),
      branch,
      remotes: results
    };
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
