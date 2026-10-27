import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, lstatSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, basename, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WORKSPACE_ROOT } from '../config.js';
import { dbGet, dbRun, dbGetOne } from '../database/db.js';

export const generateSlug = (name) => {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
};

export const validateSlug = (slug) => {
  if (!slug || typeof slug !== 'string') return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug) && slug.length <= 64;
};

export const validateGitHubUrl = (url, { allowLocal = false } = {}) => {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'Repository URL is required' };
  }
  const trimmed = url.trim();
  if (trimmed.length > 500) {
    return { valid: false, error: 'Repository URL exceeds maximum length' };
  }
  if (trimmed.includes('\n') || trimmed.includes('\r') || trimmed.includes('\0')) {
    return { valid: false, error: 'Repository URL contains invalid control characters' };
  }
  if (trimmed.startsWith('-')) {
    return { valid: false, error: 'Repository URL must not start with a dash' };
  }

  // Allow local directory or file:// URL strictly in test mode when enabled
  if (allowLocal || process.env.NODE_ENV === 'test') {
    if (trimmed.startsWith('/') || trimmed.startsWith('file://')) {
      return { valid: true, host: 'local', owner: 'test', repo: 'local', protocol: 'file', normalizedUrl: trimmed };
    }
  }

  // Reject embedded credentials in HTTPS
  if (/^https?:\/\/[^@/]+@/i.test(trimmed)) {
    return { valid: false, error: 'Embedded credentials in repository URL are prohibited' };
  }

  // HTTPS match: https://github.com/owner/repo(.git)
  const httpsMatch = trimmed.match(/^https:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
  if (httpsMatch) {
    const [, owner, repo] = httpsMatch;
    if (owner.startsWith('-') || repo.startsWith('-') || owner.includes('..') || repo.includes('..')) {
      return { valid: false, error: 'Invalid owner or repository name' };
    }
    return { valid: true, host: 'github.com', owner, repo, protocol: 'https', normalizedUrl: trimmed };
  }

  // SSH SCP-style match: git@github.com:owner/repo(.git) or git@github-coding:owner/repo(.git)
  const scpMatch = trimmed.match(/^git@(github\.com|github-coding):([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
  if (scpMatch) {
    const [, host, owner, repo] = scpMatch;
    if (owner.startsWith('-') || repo.startsWith('-') || owner.includes('..') || repo.includes('..')) {
      return { valid: false, error: 'Invalid owner or repository name' };
    }
    return { valid: true, host, owner, repo, protocol: 'ssh', normalizedUrl: trimmed };
  }

  // SSH URI-style match: ssh://git@github.com/owner/repo(.git) or ssh://git@github-coding/...
  const sshUriMatch = trimmed.match(/^ssh:\/\/git@(github\.com|github-coding)\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
  if (sshUriMatch) {
    const [, host, owner, repo] = sshUriMatch;
    if (owner.startsWith('-') || repo.startsWith('-') || owner.includes('..') || repo.includes('..')) {
      return { valid: false, error: 'Invalid owner or repository name' };
    }
    return { valid: true, host, owner, repo, protocol: 'ssh', normalizedUrl: trimmed };
  }

  return {
    valid: false,
    error: 'Unsupported repository URL. Only github.com and configured github-coding SSH alias are supported via HTTPS or SSH.'
  };
};

export const validateGitBranch = (branch) => {
  if (!branch) return { valid: true };
  const trimmed = branch.trim();
  if (trimmed.length > 255) return { valid: false, error: 'Branch name too long' };
  if (trimmed.startsWith('-')) return { valid: false, error: 'Branch name must not start with a dash' };
  if (!/^[a-zA-Z0-9._/-]+$/.test(trimmed)) return { valid: false, error: 'Branch name contains invalid characters' };
  if (trimmed.includes('..') || trimmed.includes('@{') || trimmed.includes('\\') || trimmed.endsWith('.lock') || trimmed.endsWith('/')) {
    return { valid: false, error: 'Branch name format is invalid' };
  }
  return { valid: true, branch: trimmed };
};

export const resolveWorkspacePath = (slug, workspaceRoot = WORKSPACE_ROOT) => {
  const root = resolve(workspaceRoot);
  const target = resolve(root, slug);
  if (!target.startsWith(root + sep)) {
    throw new Error('Path traversal detected');
  }
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new Error('Symlink escape detected');
    }
  }
  return target;
};

export const detectTechnologyStack = (workspacePath) => {
  if (!existsSync(workspacePath)) return 'Unknown';
  try {
    const pkgPath = join(workspacePath, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        if (deps.typescript) return 'TypeScript / Node.js';
        if (deps.react || deps.next) return 'React / Node.js';
        if (deps.vue) return 'Vue / Node.js';
        return 'Node.js / JavaScript';
      } catch {
        return 'Node.js / JavaScript';
      }
    }
    if (existsSync(join(workspacePath, 'Cargo.toml'))) return 'Rust';
    if (existsSync(join(workspacePath, 'go.mod'))) return 'Go';
    if (existsSync(join(workspacePath, 'requirements.txt')) || existsSync(join(workspacePath, 'pyproject.toml'))) return 'Python';
    if (existsSync(join(workspacePath, 'pom.xml')) || existsSync(join(workspacePath, 'build.gradle'))) return 'Java';
    if (existsSync(join(workspacePath, 'composer.json'))) return 'PHP';
    if (existsSync(join(workspacePath, 'Gemfile'))) return 'Ruby';
    if (existsSync(join(workspacePath, 'Dockerfile'))) return 'Docker';
  } catch {}
  return 'Unknown';
};

export const runGit = (args, options = {}) => {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      ...options.env
    },
    timeout: options.timeout || 60000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8'
  });

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error('Git operation timed out');
    }
    throw result.error;
  }

  if (result.status !== 0) {
    const errText = (result.stderr || result.stdout || '').trim();
    const sanitized = sanitizeGitError(errText);
    const err = new Error(sanitized || `Git exited with code ${result.status}`);
    err.status = result.status;
    err.raw = errText;
    throw err;
  }

  return (result.stdout || '').trim();
};

export const sanitizeGitError = (errText) => {
  if (!errText) return 'Git operation failed';
  let s = errText
    .replace(/(https?:\/\/)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\/home\/[a-zA-Z0-9_.-]+/g, '/home/[user]');

  if (/Remote branch .* not found/i.test(s)) {
    return 'Specified branch not found in repository';
  }
  if (/Repository not found/i.test(s)) {
    return 'Repository not found or private repository requires credentials';
  }
  if (/Permission denied \(publickey\)/i.test(s)) {
    return 'Git authentication failed: SSH key not authorized or repository requires permissions';
  }
  if (/Could not resolve host/i.test(s)) {
    return 'Could not resolve Git host';
  }
  if (/destination path .* already exists and is not an empty directory/i.test(s)) {
    return 'Destination directory already exists';
  }
  return s.split('\n')[0].slice(0, 200);
};

export const createProject = ({
  name,
  slug: providedSlug,
  description,
  repoUrl,
  repositoryUrl,
  defaultBranch,
  branch: providedBranch,
  defaultModel,
  initGit = true,
  isTest = 0,
  userId,
  creatorUserId,
  metadata = {}
}) => {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Project name is required');
  }

  const slug = (providedSlug || generateSlug(name)).trim();
  if (!validateSlug(slug)) {
    throw new Error('Invalid slug');
  }

  const existing = dbGetOne('SELECT id FROM projects WHERE slug = ?', [slug]);
  if (existing) {
    throw new Error('Slug already exists');
  }

  const workspacePath = resolveWorkspacePath(slug);
  if (existsSync(workspacePath)) {
    throw new Error('Workspace directory already exists');
  }

  const effectiveRepoUrl = (repoUrl || repositoryUrl || '').trim();
  const effectiveBranch = (providedBranch || defaultBranch || '').trim();
  const branchValidation = validateGitBranch(effectiveBranch);
  if (!branchValidation.valid) {
    throw new Error(branchValidation.error);
  }

  let createdWorkspace = false;
  let finalBranch = effectiveBranch || null;
  let detectedStack = 'Unknown';
  let repositoryProvider = null;

  try {
    if (effectiveRepoUrl) {
      // Validate GitHub URL
      const urlCheck = validateGitHubUrl(effectiveRepoUrl, { allowLocal: Boolean(isTest) || process.env.NODE_ENV === 'test' });
      if (!urlCheck.valid) {
        throw new Error(urlCheck.error);
      }
      repositoryProvider = urlCheck.host === 'github-coding' || urlCheck.host === 'github.com' ? 'github' : 'custom';

      createdWorkspace = true;

      const cloneArgs = [
        'clone',
        '--config', 'core.hooksPath=/dev/null'
      ];
      if (effectiveBranch) {
        cloneArgs.push('--branch', effectiveBranch);
      }
      cloneArgs.push('--', effectiveRepoUrl, workspacePath);

      try {
        runGit(cloneArgs);
      } catch (cloneErr) {
        // Empty repos on GitHub/Git hosts have no branches yet, fallback to branchless clone
        if (effectiveBranch && /Remote branch .* not found/i.test(cloneErr.raw || cloneErr.message)) {
          if (existsSync(workspacePath)) {
            rmSync(workspacePath, { recursive: true, force: true });
          }
          runGit(['clone', '--config', 'core.hooksPath=/dev/null', '--', effectiveRepoUrl, workspacePath]);
          let hasCommits = true;
          try {
            runGit(['-C', workspacePath, 'rev-parse', '--verify', 'HEAD']);
          } catch {
            hasCommits = false;
          }
          if (!hasCommits) {
            runGit(['-C', workspacePath, 'checkout', '-B', effectiveBranch]);
            finalBranch = effectiveBranch;
          } else {
            throw cloneErr;
          }
        } else {
          throw cloneErr;
        }
      }

      // Verify clone succeeded and .git exists
      if (!existsSync(join(workspacePath, '.git'))) {
        throw new Error('Git clone did not produce a valid repository');
      }

      // Read current branch if not explicitly specified
      if (!finalBranch) {
        try {
          finalBranch = runGit(['-C', workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD']);
        } catch {
          try {
            finalBranch = runGit(['-C', workspacePath, 'symbolic-ref', '--short', 'HEAD']);
          } catch {}
        }
      }

      detectedStack = detectTechnologyStack(workspacePath);
    } else {
      // Empty project
      mkdirSync(workspacePath, { recursive: true });
      createdWorkspace = true;

      if (initGit) {
        runGit(['-C', workspacePath, 'init', '-b', effectiveBranch || 'main', '--quiet']);
        finalBranch = effectiveBranch || 'main';
      }
    }

    const id = randomUUID();
    const effectiveModel = defaultModel || '9router/ayce-combo';
    const effectiveUserId = userId || creatorUserId || null;
    const finalMetadata = {
      ...(metadata || {}),
      stack: detectedStack,
      createdByUserId: effectiveUserId
    };
    const metadataJson = JSON.stringify(finalMetadata);

    dbRun(
      `INSERT INTO projects (
        id, name, slug, workspace_path, description, repo_url, repository_url,
        default_branch, default_model, repository_provider, creator_user_id,
        is_test, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        id,
        name.trim(),
        slug,
        workspacePath,
        description ? description.trim() : null,
        effectiveRepoUrl || null,
        effectiveRepoUrl || null,
        finalBranch || 'main',
        effectiveModel,
        repositoryProvider,
        effectiveUserId,
        isTest ? 1 : 0,
        metadataJson
      ]
    );

    return getProject(id);
  } catch (err) {
    if (createdWorkspace && existsSync(workspacePath)) {
      try {
        const root = resolve(WORKSPACE_ROOT);
        if (workspacePath.startsWith(root + sep)) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
      } catch {}
    }
    throw err;
  }
};

export const listProjects = (options = {}) => {
  const includeTest = typeof options === 'boolean' ? options : !!options.includeTest;
  let rows;
  if (includeTest) {
    rows = dbGet('SELECT * FROM projects ORDER BY created_at DESC');
  } else {
    rows = dbGet('SELECT * FROM projects WHERE is_test = 0 ORDER BY created_at DESC');
  }
  return rows.map(r => {
    r.repository_url = r.repository_url || r.repo_url || null;
    r.repo_url = r.repo_url || r.repository_url || null;
    try {
      r.metadata = JSON.parse(r.metadata_json || '{}');
    } catch {
      r.metadata = {};
    }
    return r;
  });
};

export const getProject = (id) => {
  const row = dbGetOne('SELECT * FROM projects WHERE id = ?', [id]);
  if (!row) throw new Error('Project not found');
  row.repository_url = row.repository_url || row.repo_url || null;
  row.repo_url = row.repo_url || row.repository_url || null;
  try {
    row.metadata = JSON.parse(row.metadata_json || '{}');
  } catch {
    row.metadata = {};
  }
  return row;
};

export const updateProject = (id, patch) => {
  getProject(id);
  const set = [];
  const vals = [];
  if ('name' in patch) { set.push('name = ?'); vals.push(patch.name); }
  if ('description' in patch) { set.push('description = ?'); vals.push(patch.description); }
  if ('defaultModel' in patch) { set.push('default_model = ?'); vals.push(patch.defaultModel); }
  if ('isTest' in patch) { set.push('is_test = ?'); vals.push(patch.isTest ? 1 : 0); }
  if ('metadata' in patch) { set.push('metadata_json = ?'); vals.push(JSON.stringify(patch.metadata)); }
  if (set.length === 0) return getProject(id);
  vals.push(id);
  dbRun(`UPDATE projects SET ${set.join(', ')}, updated_at = datetime('now') WHERE id = ?`, vals);
  return getProject(id);
};

export const importProject = (slugOrDir, { name, isTest = 0, userId } = {}) => {
  if (!slugOrDir || typeof slugOrDir !== 'string') {
    throw new Error('Directory name is required');
  }
  const normalized = basename(slugOrDir.trim());
  if (normalized.includes('..') || normalized.startsWith('-')) {
    throw new Error('Invalid directory name');
  }

  const workspacePath = resolveWorkspacePath(normalized);
  if (!existsSync(workspacePath)) {
    throw new Error('Directory not found');
  }

  const existing = dbGetOne('SELECT id FROM projects WHERE workspace_path = ? OR slug = ?', [workspacePath, normalized]);
  if (existing) {
    return getProject(existing.id);
  }

  let repoUrl = null;
  let branch = null;
  let provider = null;
  if (existsSync(join(workspacePath, '.git'))) {
    try {
      repoUrl = runGit(['-C', workspacePath, 'config', '--get', 'remote.origin.url']) || null;
    } catch {}
    try {
      branch = runGit(['-C', workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD']) || null;
    } catch {}
    if (repoUrl && (repoUrl.includes('github.com') || repoUrl.includes('github-coding'))) {
      provider = 'github';
    }
  }

  const stack = detectTechnologyStack(workspacePath);
  const id = randomUUID();
  const projectName = name ? name.trim() : normalized;
  const metadata = { stack, imported: true, createdByUserId: userId || null };

  dbRun(
    `INSERT INTO projects (
      id, name, slug, workspace_path, repo_url, repository_url,
      default_branch, repository_provider, creator_user_id, is_test, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      projectName,
      normalized,
      workspacePath,
      repoUrl,
      repoUrl,
      branch || 'main',
      provider,
      userId || null,
      isTest ? 1 : 0,
      JSON.stringify(metadata)
    ]
  );

  return getProject(id);
};

// ponytail: basic git config and ballo identity checks, upgrade path: deep multi-remote and signed commit verification
export const validateProjectWorkspace = (project, options = {}) => {
  if (!project) {
    return { valid: false, error: 'Project is required' };
  }

  const workspacePath = project.workspace_path;
  if (!workspacePath || !existsSync(workspacePath)) {
    return {
      valid: false,
      error: `Workspace directory does not exist: ${workspacePath}`
    };
  }

  let actualRemote = null;
  const gitDir = join(workspacePath, '.git');
  if (existsSync(gitDir)) {
    try {
      actualRemote = runGit(['-C', workspacePath, 'config', '--get', 'remote.origin.url']) || null;
    } catch {}
  }

  const projectName = (project.name || '').toLowerCase();
  const projectSlug = (project.slug || '').toLowerCase();
  const detectedStack = detectTechnologyStack(workspacePath);

  // Critical Ballo repository identity check
  if (projectName === 'ballo' || projectSlug === 'ballo') {
    const intendedRepo = 'https://github.com/lukman-ss/ballo';
    const isCodeOrchestrator = actualRemote && (actualRemote.includes('codeorchestrator') || actualRemote.includes('coding-orchestrator'));
    const isNotBallo = !actualRemote || !actualRemote.includes('/ballo');
    if (isCodeOrchestrator || isNotBallo) {
      return {
        valid: false,
        mismatch: true,
        error: `Repository mismatch detected: Project 'ballo' workspace remote is '${actualRemote}' (${detectedStack}) but intended repository is '${intendedRepo}' (Go). Execution blocked to protect workspace integrity. Explicit authorized correction required.`,
        actualRemote,
        expectedRemote: intendedRepo,
        detectedStack,
        expectedStack: 'Go'
      };
    }
  }

  // Explicit expected target repository check
  const expectedRepo = options.expectedRepoUrl || project.metadata?.expectedRepoUrl;
  if (expectedRepo && actualRemote) {
    const normActual = actualRemote.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
    const normExpected = expectedRepo.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
    if (normActual !== normExpected) {
      const checkA = validateGitHubUrl(actualRemote);
      const checkE = validateGitHubUrl(expectedRepo);
      const matchOwnerRepo =
        checkA.valid &&
        checkE.valid &&
        checkA.owner?.toLowerCase() === checkE.owner?.toLowerCase() &&
        checkA.repo?.toLowerCase() === checkE.repo?.toLowerCase();

      if (!matchOwnerRepo) {
        return {
          valid: false,
          mismatch: true,
          error: `Repository mismatch detected: Workspace remote '${actualRemote}' does not match expected repository '${expectedRepo}'.`,
          actualRemote,
          expectedRemote: expectedRepo
        };
      }
    }
  }

  return {
    valid: true,
    actualRemote,
    stack: detectedStack
  };
};

// ponytail: metadata-only repair without filesystem mutation, upgrade path: interactive worktree migration
export const repairProject = (id, { repoUrl, defaultBranch, confirm = false, userId = null } = {}) => {
  if (!confirm) {
    throw new Error('Explicit confirmation is required to repair project configuration');
  }
  const project = getProject(id);
  const metadata = { ...(project.metadata || {}) };

  if (repoUrl) {
    const urlCheck = validateGitHubUrl(repoUrl, { allowLocal: Boolean(project.is_test) || process.env.NODE_ENV === 'test' });
    if (!urlCheck.valid) {
      throw new Error(`Invalid repository URL: ${urlCheck.error}`);
    }
    metadata.expectedRepoUrl = repoUrl;
  }
  metadata.repairedAt = new Date().toISOString();
  metadata.repairedByUserId = userId;

  const set = ['metadata_json = ?'];
  const vals = [JSON.stringify(metadata)];

  if (repoUrl) {
    set.push('repo_url = ?', 'repository_url = ?');
    vals.push(repoUrl, repoUrl);
  }
  if (defaultBranch) {
    const branchCheck = validateGitBranch(defaultBranch);
    if (!branchCheck.valid) {
      throw new Error(`Invalid branch: ${branchCheck.error}`);
    }
    set.push('default_branch = ?');
    vals.push(defaultBranch);
  }

  vals.push(project.id);
  dbRun(`UPDATE projects SET ${set.join(', ')}, updated_at = datetime('now') WHERE id = ?`, vals);
  return getProject(project.id);
};
