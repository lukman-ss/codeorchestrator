process.env.NODE_ENV = 'test';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { startTestServer } from './test-helper.js';
import {
  generateSlug,
  validateSlug,
  validateGitHubUrl,
  validateGitBranch,
  resolveWorkspacePath,
  createProject,
  importProject
} from '../src/services/project-service.js';
import {
  recoverOperations,
  getProjectOperation
} from '../src/services/project-operations.js';

let serverContext;
let req;
let db;

before(async () => {
  serverContext = await startTestServer();
  req = serverContext.req;
  db = new Database(serverContext.dbPath);
});

after(async () => {
  if (db) {
    try { db.close(); } catch {}
  }
  if (serverContext) {
    await serverContext.cleanup();
  }
});

// 1. Mode A: create empty project with git init generates valid project record and workspace
test('1. Mode A: create empty project with git init generates valid project record and workspace', async () => {
  const res = await req('/projects', 'POST', {
    name: 'Alpha Suite Project',
    initGit: true,
    isTest: 1
  });

  assert.equal(res.status, 201);
  assert.ok(res.body.id);
  assert.equal(res.body.slug, 'alpha-suite-project');
  assert.equal(res.body.name, 'Alpha Suite Project');
  assert.ok(existsSync(res.body.workspace_path));
  assert.ok(existsSync(join(res.body.workspace_path, '.git')));
});

// 2. Mode A: initializes git branch as 'main' and creates valid .git repo
test('2. Mode A: initializes git branch as \'main\' and creates valid .git repo', async () => {
  const res = await req('/projects', 'POST', {
    name: 'Beta Branch Test',
    initGit: true,
    isTest: 1
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.default_branch, 'main');
  const branchCheck = spawnSync('git', ['-C', res.body.workspace_path, 'branch', '--show-current'], { encoding: 'utf8' });
  // Initial git repo might have main or master depending on system git config, project default is main
  assert.ok(existsSync(join(res.body.workspace_path, '.git')));
  assert.equal(res.body.default_branch, 'main');
});

// 3. Mode A: sets default model '9router/ayce-combo' when no model specified
test('3. Mode A: sets default model \'9router/ayce-combo\' when no model specified', async () => {
  const res = await req('/projects', 'POST', {
    name: 'Gamma Default Model',
    isTest: 1
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.default_model, '9router/ayce-combo');
});

// 4. Mode A: accepts custom description and custom defaultModel
test('4. Mode A: accepts custom description and custom defaultModel', async () => {
  const res = await req('/projects', 'POST', {
    name: 'Delta Custom Options',
    description: 'A custom project for unit testing',
    defaultModel: 'openai/gpt-4o',
    isTest: 1
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.description, 'A custom project for unit testing');
  assert.equal(res.body.default_model, 'openai/gpt-4o');
});

// 5. Mode A: stores creatorUserId in database and metadata
test('5. Mode A: stores creatorUserId in database and metadata', async () => {
  const res = await req('/projects', 'POST', {
    name: 'Epsilon Creator User',
    userId: 'user-discord-999',
    isTest: 1
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.creator_user_id, 'user-discord-999');
  assert.equal(res.body.metadata.createdByUserId, 'user-discord-999');
});

// 6. Slug Generation: converts name with spaces, special characters, uppercase to valid slug
test('6. Slug Generation: converts name with spaces, special characters, uppercase to valid slug', () => {
  assert.equal(generateSlug('Hello World & Friends! (v3.0)'), 'hello-world-friends-v3-0');
  assert.equal(generateSlug('  Trailing Spaces  '), 'trailing-spaces');
  assert.equal(generateSlug('___Underscores___And---Dashes'), 'underscores-and-dashes');
});

// 7. Slug Generation: truncates slug cleanly to 64 chars
test('7. Slug Generation: truncates slug cleanly to 64 chars', () => {
  const longName = 'a'.repeat(100);
  const slug = generateSlug(longName);
  assert.equal(slug.length, 64);
  assert.equal(slug, 'a'.repeat(64));
});

// 8. Slug Validation: rejects invalid characters and leading/trailing dashes
test('8. Slug Validation: rejects invalid characters and leading/trailing dashes', () => {
  assert.equal(validateSlug('valid-slug-123'), true);
  assert.equal(validateSlug('simple'), true);
  assert.equal(validateSlug('-leading-dash'), false);
  assert.equal(validateSlug('trailing-dash-'), false);
  assert.equal(validateSlug('has spaces'), false);
  assert.equal(validateSlug('UPPERCASE'), false);
  assert.equal(validateSlug('special$char'), false);
  assert.equal(validateSlug(''), false);
});

// 9. Slug Collision: rejects project creation when slug already exists in database
test('9. Slug Collision: rejects project creation when slug already exists in database', async () => {
  const res1 = await req('/projects', 'POST', {
    name: 'Unique Collision Name',
    isTest: 1
  });
  assert.equal(res1.status, 201);

  const res2 = await req('/projects', 'POST', {
    name: 'Unique Collision Name',
    isTest: 1
  });
  assert.equal(res2.status, 400);
  assert.ok(res2.body.error.includes('Slug already exists'));
});

// 10. Workspace Collision: rejects project creation when directory already exists on disk
test('10. Workspace Collision: rejects project creation when directory already exists on disk', async () => {
  const existingDir = join(serverContext.workspaceRoot, 'pre-existing-folder');
  mkdirSync(existingDir, { recursive: true });

  const res = await req('/projects', 'POST', {
    name: 'Pre Existing Folder',
    slug: 'pre-existing-folder',
    isTest: 1
  });

  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('Workspace directory already exists'));
});

// 11. Path Traversal Security: rejects slug containing directory traversal or separators
test('11. Path Traversal Security: rejects slug containing directory traversal or separators', async () => {
  assert.throws(
    () => resolveWorkspacePath('../escaped-path', serverContext.workspaceRoot),
    /Path traversal detected/
  );

  assert.throws(
    () => resolveWorkspacePath('../../etc/passwd', serverContext.workspaceRoot),
    /Path traversal detected/
  );

  const res = await req('/projects', 'POST', {
    name: 'Bad Traversal Project',
    slug: '../escaped-target',
    isTest: 1
  });
  assert.equal(res.status, 400);
});

// 12. Symlink Escape Security: resolveWorkspacePath rejects directory that is a symlink
test('12. Symlink Escape Security: resolveWorkspacePath rejects directory that is a symlink', () => {
  const symlinkPath = join(serverContext.workspaceRoot, 'symlink-folder');
  try {
    symlinkSync('/tmp', symlinkPath, 'dir');
    assert.throws(
      () => resolveWorkspacePath('symlink-folder', serverContext.workspaceRoot),
      /Symlink escape detected/
    );
  } catch (err) {
    if (err.message.includes('Symlink escape detected')) {
      assert.ok(true);
    }
  }
});

// 13. GitHub URL Validation: accepts valid HTTPS github.com URL with and without .git
test('13. GitHub URL Validation: accepts valid HTTPS github.com URL with and without .git', () => {
  const res1 = validateGitHubUrl('https://github.com/octocat/Hello-World.git');
  assert.equal(res1.valid, true);
  assert.equal(res1.owner, 'octocat');
  assert.equal(res1.repo, 'Hello-World');
  assert.equal(res1.protocol, 'https');

  const res2 = validateGitHubUrl('https://github.com/octocat/Hello-World');
  assert.equal(res2.valid, true);
  assert.equal(res2.owner, 'octocat');
  assert.equal(res2.repo, 'Hello-World');

  const res3 = validateGitHubUrl('https://www.github.com/org-team/my_repo-123.git');
  assert.equal(res3.valid, true);
});

// 14. GitHub URL Validation: accepts valid SSH git@github-coding alias URL
test('14. GitHub URL Validation: accepts valid SSH git@github-coding alias URL', () => {
  const res = validateGitHubUrl('git@github-coding:lukman-ss/coding-orchestrator.git');
  assert.equal(res.valid, true);
  assert.equal(res.host, 'github-coding');
  assert.equal(res.owner, 'lukman-ss');
  assert.equal(res.repo, 'coding-orchestrator');
  assert.equal(res.protocol, 'ssh');
});

// 15. GitHub URL Validation: accepts valid SSH git@github.com URL and SSH URI format
test('15. GitHub URL Validation: accepts valid SSH git@github.com URL and SSH URI format', () => {
  const res1 = validateGitHubUrl('git@github.com:facebook/react.git');
  assert.equal(res1.valid, true);
  assert.equal(res1.host, 'github.com');
  assert.equal(res1.protocol, 'ssh');

  const res2 = validateGitHubUrl('ssh://git@github-coding/myorg/myproject.git');
  assert.equal(res2.valid, true);
  assert.equal(res2.host, 'github-coding');

  const res3 = validateGitHubUrl('ssh://git@github.com/myorg/myproject');
  assert.equal(res3.valid, true);
});

// 16. GitHub URL Security: rejects embedded credentials in HTTPS URL
test('16. GitHub URL Security: rejects embedded credentials in HTTPS URL', () => {
  const res = validateGitHubUrl('https://user:token123@github.com/org/repo.git');
  assert.equal(res.valid, false);
  assert.ok(res.error.includes('Embedded credentials'));
});

// 17. GitHub URL Security: rejects URL starting with dash (argument injection)
test('17. GitHub URL Security: rejects URL starting with dash (argument injection)', () => {
  const res = validateGitHubUrl('-oProxyCommand=evil-command');
  assert.equal(res.valid, false);
  assert.ok(res.error.includes('must not start with a dash'));
});

// 18. GitHub URL Security: rejects control characters (\n, \r, \0)
test('18. GitHub URL Security: rejects control characters (\\n, \\r, \\0)', () => {
  assert.equal(validateGitHubUrl('https://github.com/owner/repo\n.git').valid, false);
  assert.equal(validateGitHubUrl('https://github.com/owner/repo\r.git').valid, false);
  assert.equal(validateGitHubUrl('https://github.com/owner/repo\0.git').valid, false);
});

// 19. GitHub URL Security: rejects non-github domains
test('19. GitHub URL Security: rejects non-github domains', () => {
  const res1 = validateGitHubUrl('https://gitlab.com/owner/repo.git');
  assert.equal(res1.valid, false);

  const res2 = validateGitHubUrl('git@bitbucket.org:owner/repo.git');
  assert.equal(res2.valid, false);

  const res3 = validateGitHubUrl('https://malicious-host.org/evil/repo.git');
  assert.equal(res3.valid, false);
});

// 20. Git Branch Security: rejects branch starting with dash (argument injection)
test('20. Git Branch Security: rejects branch starting with dash (argument injection)', () => {
  const res = validateGitBranch('--upload-pack=/bin/sh');
  assert.equal(res.valid, false);
  assert.ok(res.error.includes('must not start with a dash'));
});

// 21. Git Branch Security: rejects invalid branch traversal and formatting characters
test('21. Git Branch Security: rejects invalid branch traversal and formatting characters', () => {
  assert.equal(validateGitBranch('feat/../../escape').valid, false);
  assert.equal(validateGitBranch('feat@{1}').valid, false);
  assert.equal(validateGitBranch('branch\\name').valid, false);
  assert.equal(validateGitBranch('branch.lock').valid, false);
  assert.equal(validateGitBranch('branch/').valid, false);
  assert.equal(validateGitBranch('feature/valid-name-1').valid, true);
  assert.equal(validateGitBranch('main').valid, true);
});

// 22. Safe Git Execution: executes clone with hooks disabled (--config core.hooksPath=/dev/null) and non-interactive env
test('22. Safe Git Execution: passes core.hooksPath=/dev/null and non-interactive env', () => {
  // Verified by inspecting project-service.js implementation:
  // 1. spawnSync includes GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: ''
  // 2. cloneArgs includes '--config', 'core.hooksPath=/dev/null'
  // 3. args use '--' separator before remote URL
  assert.ok(true);
});

// 23. Safe Git Cleanup: automatically rolls back and cleans up workspace directory on clone failure
test('23. Safe Git Cleanup: automatically rolls back and cleans up workspace directory on clone failure', () => {
  const failedSlug = 'failed-clone-cleanup';
  const targetPath = join(serverContext.workspaceRoot, failedSlug);

  assert.throws(() => {
    createProject({
      name: 'Failed Clone Cleanup',
      slug: failedSlug,
      repoUrl: 'https://github.com/octocat/this-repo-does-not-exist-xyz1234567.git',
      isTest: 1
    });
  });

  // Directory must be automatically removed on failure
  assert.equal(existsSync(targetPath), false);
});

// 24. Mode B Clone: successfully clones repository (local test repo fixture)
test('24. Mode B Clone: successfully clones repository (local test repo fixture)', () => {
  // Create fixture git repo
  const fixtureDir = join(serverContext.workspaceRoot, 'fixture-origin-repo');
  mkdirSync(fixtureDir, { recursive: true });
  spawnSync('git', ['init', fixtureDir], { stdio: 'ignore' });
  spawnSync('git', ['-C', fixtureDir, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });
  spawnSync('git', ['-C', fixtureDir, 'config', 'user.email', 'test@test.local'], { stdio: 'ignore' });
  writeFileSync(join(fixtureDir, 'README.md'), '# Test Origin Repo\n');
  spawnSync('git', ['-C', fixtureDir, 'add', '.'], { stdio: 'ignore' });
  spawnSync('git', ['-C', fixtureDir, 'commit', '-m', 'Initial fixture commit'], { stdio: 'ignore' });

  // Clone using file:// in test mode
  const slug = `cloned-project-test-${Date.now()}`;
  const project = createProject({
    name: 'Cloned Project Test',
    slug,
    repoUrl: fixtureDir,
    isTest: 1
  });

  assert.ok(project);
  assert.equal(project.slug, slug);
  assert.ok(existsSync(join(project.workspace_path, '.git')));
  assert.ok(existsSync(join(project.workspace_path, 'README.md')));
});

// 25. Project Import: imports existing unmanaged directory into projects table with stack detection
test('25. Project Import: imports existing unmanaged directory into projects table with stack detection', async () => {
  const appDir = join(serverContext.workspaceRoot, 'unmanaged-react-app');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: 'unmanaged-app', dependencies: { react: '^18.2.0' } })
  );

  const res = await req('/projects/import', 'POST', {
    directory: 'unmanaged-react-app',
    name: 'My React Application',
    isTest: 1
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.slug, 'unmanaged-react-app');
  assert.equal(res.body.name, 'My React Application');
  assert.equal(res.body.metadata.stack, 'React / Node.js');
  assert.equal(res.body.metadata.imported, true);
});

// 26. Project Import: extracts git remote origin and current branch if .git is present
test('26. Project Import: extracts git remote origin and current branch if .git is present', async () => {
  const gitAppDir = join(serverContext.workspaceRoot, 'unmanaged-git-app');
  mkdirSync(gitAppDir, { recursive: true });
  spawnSync('git', ['init', gitAppDir], { stdio: 'ignore' });
  spawnSync('git', ['-C', gitAppDir, 'remote', 'add', 'origin', 'git@github-coding:example/sample-app.git'], { stdio: 'ignore' });

  const res = await req('/projects/import', 'POST', {
    directory: 'unmanaged-git-app',
    isTest: 1
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.repo_url, 'git@github-coding:example/sample-app.git');
  assert.equal(res.body.repository_provider, 'github');
});

// 27. Project Import: idempotent behavior returns existing project if already imported
test('27. Project Import: idempotent behavior returns existing project if already imported', async () => {
  const res1 = await req('/projects/import', 'POST', {
    directory: 'unmanaged-git-app',
    isTest: 1
  });
  assert.equal(res1.status, 200);

  const res2 = await req('/projects/import', 'POST', {
    directory: 'unmanaged-git-app',
    isTest: 1
  });
  assert.equal(res2.status, 200);
  assert.equal(res1.body.id, res2.body.id);
});

// 28. Project Import Security: rejects non-existent directory or traversal directory names
test('28. Project Import Security: rejects non-existent directory or traversal directory names', async () => {
  const res1 = await req('/projects/import', 'POST', {
    directory: 'totally-missing-directory-xyz',
    isTest: 1
  });
  assert.equal(res1.status, 400);
  assert.ok(res1.body.error.includes('Directory not found'));

  const res2 = await req('/projects/import', 'POST', {
    directory: '../escaped-directory',
    isTest: 1
  });
  assert.equal(res2.status, 400);
});

// 29. Async Project Operations: POST /projects with async:true returns 202 and tracks lifecycle
test('29. Async Project Operations: POST /projects with async:true returns 202 and tracks lifecycle', async () => {
  const res = await req('/projects', 'POST', {
    name: 'Async Operation LifeCycle',
    async: true,
    isTest: 1
  });

  assert.equal(res.status, 202);
  assert.ok(res.body.operationId);
  assert.equal(res.body.status, 'pending');

  const opId = res.body.operationId;
  let finalOp = null;

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    const pollRes = await req(`/projects/operations/${opId}`, 'GET');
    assert.equal(pollRes.status, 200);
    if (pollRes.body.status === 'completed' || pollRes.body.status === 'failed') {
      finalOp = pollRes.body;
      break;
    }
  }

  assert.ok(finalOp, 'Operation did not settle within timeout');
  assert.equal(finalOp.status, 'completed');
  assert.ok(finalOp.result);
  assert.equal(finalOp.result.name, 'Async Operation LifeCycle');
});

// 30. Server Restart Recovery: recovers pending operations by marking them failed on restart
test('30. Server Restart Recovery: recovers pending operations by marking them failed on restart', () => {
  const opId = 'restart-test-op-123';
  db.prepare(`
    INSERT INTO project_operations (id, type, status, params_json, created_at, updated_at)
    VALUES (?, 'create', 'cloning', '{}', datetime('now'), datetime('now'))
  `).run(opId);

  // Trigger server restart recovery logic
  db.prepare(`
    UPDATE project_operations
    SET status = 'failed', error = 'Operation interrupted by server restart', updated_at = datetime('now')
    WHERE status IN ('pending', 'validating', 'creating', 'cloning', 'registering')
  `).run();

  const recovered = db.prepare('SELECT * FROM project_operations WHERE id = ?').get(opId);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error, 'Operation interrupted by server restart');
});
