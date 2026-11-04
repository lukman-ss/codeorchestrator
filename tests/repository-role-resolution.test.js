import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  normalizeGitUrl,
  areEquivalentGitUrls,
  validateGitHubUrl
} from '../src/services/project-service.js';
import {
  classifyRepositoryReferences,
  extractCandidateUrls,
  REPOSITORY_ROLES
} from '../src/services/repository-classifier.js';
import { ProjectContextResolver } from '../src/services/project-context-resolver.js';
import {
  recoverRepositoryMismatchTask,
  getTask,
  createTask
} from '../src/services/task-service.js';
import { Supervisor } from '../src/services/supervisor.js';
import { dbGet, dbGetOne, dbRun } from '../src/database/db.js';
import {
  extractRepositoryDirective,
  checkRepositoryMismatch
} from '../integrations/discord/src/natural-chat.js';
import { formatSpecificationCard } from '../integrations/discord/src/notifications.js';

// ============================================================================
// Group 1: Canonical Git URL Normalization & Equivalence (Tests 1–6)
// ============================================================================

test('1. Normalizes HTTPS Git URL with .git and trailing slash to canonical owner/repo', () => {
  const norm = normalizeGitUrl('https://github.com/Lukman-SS/Ballo-Todo.git/');
  assert.equal(norm.valid, true);
  assert.equal(norm.canonical, 'github.com/lukman-ss/ballo-todo');
  assert.equal(norm.owner, 'Lukman-SS');
  assert.equal(norm.repo, 'Ballo-Todo');
});

test('2. Normalizes SSH SCP-style URL to canonical owner/repo', () => {
  const norm = normalizeGitUrl('git@github.com:lukman-ss/ballo-todo.git');
  assert.equal(norm.valid, true);
  assert.equal(norm.canonical, 'github.com/lukman-ss/ballo-todo');
  assert.equal(norm.protocol, 'ssh');
});

test('3. Normalizes configured SSH alias (github-coding) to canonical owner/repo', () => {
  const norm = normalizeGitUrl('git@github-coding:lukman-ss/ballo-todo');
  assert.equal(norm.valid, true);
  assert.equal(norm.canonical, 'github.com/lukman-ss/ballo-todo');
});

test('4. Normalizes SSH URI syntax ssh://git@github.com/owner/repo.git', () => {
  const norm = normalizeGitUrl('ssh://git@github.com/lukman-ss/ballo-todo.git');
  assert.equal(norm.valid, true);
  assert.equal(norm.canonical, 'github.com/lukman-ss/ballo-todo');
  assert.equal(areEquivalentGitUrls(
    'https://github.com/lukman-ss/ballo-todo',
    'ssh://git@github.com/lukman-ss/ballo-todo.git'
  ), true);
});

test('5. Rejects embedded credentials in HTTPS URL', () => {
  const norm = normalizeGitUrl('https://token:secret123@github.com/lukman-ss/ballo-todo.git');
  assert.equal(norm.valid, false);
  assert.match(norm.error, /embedded credentials/i);
});

test('6. Rejects URL spoofing, invalid characters, and non-supported protocols', () => {
  assert.equal(normalizeGitUrl('ftp://github.com/lukman-ss/ballo-todo').valid, false);
  assert.equal(normalizeGitUrl('https://github.com.attacker.com/lukman-ss/ballo-todo').valid, false);
  assert.equal(normalizeGitUrl('https://github.com/lukman-ss/ballo-todo\0evil').valid, false);
  assert.equal(normalizeGitUrl('-https://github.com/lukman-ss/ballo-todo').valid, false);
});

// ============================================================================
// Group 2: Repository Role Classification Heuristics (Tests 7–16)
// ============================================================================

test('7. Classifies explicit target repository directive as TARGET (target: true)', () => {
  const text = 'target repo: https://github.com/lukman-ss/ballo-todo.git';
  const refs = classifyRepositoryReferences(text);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].role, REPOSITORY_ROLES.TARGET);
  assert.equal(refs[0].target, true);
  assert.equal(refs[0].source, 'action_directive');
});

test('8. Classifies explicit modification directive targeting repo directly as TARGET (target: true)', () => {
  const text = 'Please modify repository directly: https://github.com/lukman-ss/ballo-starter.git';
  const refs = classifyRepositoryReferences(text);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].role, REPOSITORY_ROLES.TARGET);
  assert.equal(refs[0].target, true);
});

test('9. Classifies starter repository citation as STARTER (target: false)', () => {
  const textEn = 'Use this starter: https://github.com/lukman-ss/ballo-starter';
  const refsEn = classifyRepositoryReferences(textEn);
  assert.equal(refsEn.length, 1);
  assert.equal(refsEn[0].role, REPOSITORY_ROLES.STARTER);
  assert.equal(refsEn[0].target, false);

  const textId = 'Gunakan Ballo Starter sebagai fondasi:\nhttps://github.com/lukman-ss/ballo-starter';
  const refsId = classifyRepositoryReferences(textId);
  assert.equal(refsId.length, 1);
  assert.equal(refsId[0].role, REPOSITORY_ROLES.STARTER);
  assert.equal(refsId[0].target, false);
});

test('10. Classifies template repository citation as TEMPLATE (target: false)', () => {
  const text = 'template: https://github.com/example-org/todo-template.git';
  const refs = classifyRepositoryReferences(text);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].role, REPOSITORY_ROLES.TEMPLATE);
  assert.equal(refs[0].target, false);
});

test('11. Classifies framework dependency as FRAMEWORK_DEPENDENCY (target: false)', () => {
  const text = 'Framework: https://github.com/lukman-ss/ballo\nBuild with the framework';
  const refs = classifyRepositoryReferences(text);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].role, REPOSITORY_ROLES.FRAMEWORK_DEPENDENCY);
  assert.equal(refs[0].target, false);
});

test('12. Classifies library or package dependency as LIBRARY_DEPENDENCY (target: false)', () => {
  const text = 'dependency: https://github.com/mattn/go-sqlite3.git';
  const refs = classifyRepositoryReferences(text);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].role, REPOSITORY_ROLES.LIBRARY_DEPENDENCY);
  assert.equal(refs[0].target, false);
});

test('13. Classifies documentation reference as DOCUMENTATION (target: false)', () => {
  const text = 'docs: https://github.com/gin-gonic/gin\nRead API guide';
  const refs = classifyRepositoryReferences(text);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].role, REPOSITORY_ROLES.DOCUMENTATION);
  assert.equal(refs[0].target, false);
});

test('14. Classifies example or demo citation as EXAMPLE (target: false)', () => {
  const text = 'Lihat contoh implementasi:\ncontoh: https://github.com/example/sample-app';
  const refs = classifyRepositoryReferences(text);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].role, REPOSITORY_ROLES.EXAMPLE);
  assert.equal(refs[0].target, false);
});

test('15. Classifies git submodule reference as SUBMODULE (target: false)', () => {
  const text = 'Submodule configuration:\ngit submodule add https://github.com/vendor/sub-tool.git';
  const refs = classifyRepositoryReferences(text);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].role, REPOSITORY_ROLES.SUBMODULE);
  assert.equal(refs[0].target, false);
});

test('16. Classifies markdown code block and blockquote URLs as EXTERNAL_REFERENCE (target: false)', () => {
  const codeBlockText = 'Check the readme:\n```bash\ngit clone https://github.com/random/external-tool.git\n```';
  const refsCode = classifyRepositoryReferences(codeBlockText);
  assert.equal(refsCode.length, 1);
  assert.equal(refsCode[0].role, REPOSITORY_ROLES.EXTERNAL_REFERENCE);
  assert.equal(refsCode[0].target, false);

  const quoteText = '> Reference: https://github.com/quote/ref-repo';
  const refsQuote = classifyRepositoryReferences(quoteText);
  assert.equal(refsQuote.length, 1);
  assert.equal(refsQuote[0].role, REPOSITORY_ROLES.EXTERNAL_REFERENCE);
  assert.equal(refsQuote[0].target, false);
});

// ============================================================================
// Group 3: Authority Precedence Hierarchy & Scope Conflict Enforcement (Tests 17–22)
// ============================================================================

test('17. Authority Precedence: Registered project dictates target workspace over specification starter citation', () => {
  const project = {
    id: 'proj-ballo-todo',
    slug: 'ballo-todo',
    name: 'ballo-todo',
    workspace_path: '/tmp/workspace/ballo-todo',
    repository_url: 'git@github.com:lukman-ss/ballo-todo.git'
  };
  const prompt = `
project: ballo-todo
Bangun aplikasi todo menggunakan Ballo Starter sebagai fondasi:
Starter: https://github.com/lukman-ss/ballo-starter
Framework: https://github.com/lukman-ss/ballo
  `;

  const context = ProjectContextResolver.resolveProjectContext({
    project,
    promptText: prompt
  });

  assert.equal(context.execution.allowed, true);
  assert.equal(context.execution.validation_result, 'PASS');
  assert.equal(context.project.canonical_repository, 'github.com/lukman-ss/ballo-todo');
  assert.equal(context.repository_references.length, 2);
  assert.equal(context.repository_references[0].role, REPOSITORY_ROLES.STARTER);
  assert.equal(context.repository_references[0].target, false);
});

test('18. Explicit project selection directive in current request takes precedence', () => {
  const dummyProject = {
    id: 'proj-123',
    slug: 'ballo-todo',
    name: 'ballo-todo',
    workspace_path: '/tmp/test',
    repository_url: 'git@github.com:lukman-ss/ballo-todo.git'
  };

  const context = ProjectContextResolver.resolveProjectContext({
    project: dummyProject,
    projectDirective: 'ballo-todo',
    promptText: 'Implement new features'
  });

  assert.equal(context.project.slug, 'ballo-todo');
  assert.equal(context.execution.allowed, true);
});

test('19. Rejects with SCOPE_CONFLICT when specification directs modifications against external repository', () => {
  const project = {
    id: 'proj-ballo-todo',
    slug: 'ballo-todo',
    name: 'ballo-todo',
    workspace_path: '/tmp/workspace/ballo-todo',
    repository_url: 'git@github.com:lukman-ss/ballo-todo.git'
  };
  const maliciousPrompt = 'project: ballo-todo\nmodify repository directly: https://github.com/lukman-ss/ballo-starter.git\npush changes';

  const context = ProjectContextResolver.resolveProjectContext({
    project,
    promptText: maliciousPrompt
  });

  assert.equal(context.execution.allowed, false);
  assert.equal(context.execution.validation_result, 'SCOPE_CONFLICT');
  assert.equal(context.execution.scope_conflict, true);
  assert.match(context.execution.validation_reason, /scope conflict/i);
});

test('20. Rejects with SCOPE_CONFLICT when explicit target repository conflicts with selected project', () => {
  const project = {
    id: 'proj-ballo-todo',
    slug: 'ballo-todo',
    name: 'ballo-todo',
    workspace_path: '/tmp/workspace/ballo-todo',
    repository_url: 'git@github.com:lukman-ss/ballo-todo.git'
  };
  const conflictingPrompt = 'target repo: https://github.com/lukman-ss/other-project.git\nDo changes';

  const context = ProjectContextResolver.resolveProjectContext({
    project,
    promptText: conflictingPrompt
  });

  assert.equal(context.execution.allowed, false);
  assert.equal(context.execution.validation_result, 'SCOPE_CONFLICT');
  assert.match(context.execution.validation_reason, /does not match selected project/i);
});

test('21. Critical workspace remote mismatch guard blocks execution when Ballo workspace points to codeorchestrator', () => {
  // Mock GitOperations check inside resolveProjectContext
  const balloProject = {
    id: 'proj-ballo-evil',
    slug: 'ballo-todo',
    name: 'ballo-todo',
    workspace_path: process.cwd(), // codeorchestrator repo!
    repository_url: 'git@github.com:lukman-ss/ballo-todo.git'
  };

  const context = ProjectContextResolver.resolveProjectContext({
    project: balloProject,
    promptText: 'Add new feature'
  });

  assert.equal(context.execution.allowed, false);
  assert.equal(context.execution.validation_result, 'WORKSPACE_REMOTE_MISMATCH');
  assert.match(context.execution.validation_reason, /ballo workspace remote points to codeorchestrator/i);
});

test('22. Default target match: specification URL matching project canonical is recognized as TARGET', () => {
  const refs = classifyRepositoryReferences('Check out our repo: https://github.com/lukman-ss/ballo-todo', {
    defaultTargetCanonical: 'github.com/lukman-ss/ballo-todo'
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].role, REPOSITORY_ROLES.TARGET);
  assert.equal(refs[0].target, true);
});

// ============================================================================
// Group 4: Structured OpenCode Handoff Context & Prompt Preservation (Tests 23–25)
// ============================================================================

test('23. buildProjectContextPrompt prepends structured # PROJECT CONTEXT header', () => {
  const project = {
    slug: 'ballo-todo',
    repository_url: 'git@github.com:lukman-ss/ballo-todo.git',
    workspace_path: '/home/user/workspace/ballo-todo',
    default_branch: 'main'
  };
  const references = [
    { role: 'STARTER', url: 'https://github.com/lukman-ss/ballo-starter', canonical: 'github.com/lukman-ss/ballo-starter' },
    { role: 'FRAMEWORK_DEPENDENCY', url: 'https://github.com/lukman-ss/ballo', canonical: 'github.com/lukman-ss/ballo' }
  ];
  const originalPrompt = 'Implement todo priority filtering';

  const handoff = ProjectContextResolver.buildProjectContextPrompt({
    project,
    promptText: originalPrompt,
    references
  });

  assert.match(handoff, /^# PROJECT CONTEXT/);
  assert.match(handoff, /Target Project: ballo-todo/);
  assert.match(handoff, /Target Repository: git@github\.com:lukman-ss\/ballo-todo\.git/);
  assert.match(handoff, /\[STARTER\] https:\/\/github\.com\/lukman-ss\/ballo-starter/);
  assert.match(handoff, /\[FRAMEWORK_DEPENDENCY\] https:\/\/github\.com\/lukman-ss\/ballo/);
});

test('24. Original user specification is preserved verbatim in OpenCode handoff prompt', () => {
  const originalPrompt = '# Original Title\n\nSpecific detailed requirements with Indonesian text: Jangan ubah fondasi.';
  const handoff = ProjectContextResolver.buildProjectContextPrompt({
    project: { slug: 'test-app' },
    promptText: originalPrompt
  });

  assert.ok(handoff.endsWith(originalPrompt));
});

test('25. OpenCode handoff instructions mandate Go module declaration and Gate 3 preservation', () => {
  const handoff = ProjectContextResolver.buildProjectContextPrompt({
    project: { slug: 'ballo-todo' },
    promptText: 'Build app'
  });

  assert.match(handoff, /Preserve Go module declarations/);
  assert.match(handoff, /read-only references/);
  assert.match(handoff, /Do NOT perform automated git push/);
});

// ============================================================================
// Group 5: Safe Task Recovery, Audit Persistence & Gate 3 Enforcement (Tests 26–30)
// ============================================================================

test('26. Database audit persistence: repository references and roles are persisted into repository_references table', () => {
  const testTaskId = randomUUID();
  const testProjectId = '2a380312-60c7-4fe5-9046-a49ecb487cbd';

  dbRun(
    `INSERT INTO tasks (id, project_id, prompt, status, workflow_status, execution_status, created_at)
     VALUES (?, ?, 'audit test', 'queued', 'queued', 'queued', datetime('now'))`,
    [testTaskId, testProjectId]
  );

  const references = [
    { role: 'STARTER', url: 'https://github.com/lukman-ss/ballo-starter', canonical: 'github.com/lukman-ss/ballo-starter', target: false, source: 'starter_context' },
    { role: 'FRAMEWORK_DEPENDENCY', url: 'https://github.com/lukman-ss/ballo', canonical: 'github.com/lukman-ss/ballo', target: false, source: 'framework_context' }
  ];

  ProjectContextResolver.persistRepositoryReferences(testTaskId, testProjectId, references, 'PASS', null);

  const stored = ProjectContextResolver.getPersistedReferences(testTaskId);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].reference_role, 'STARTER');
  assert.equal(stored[0].is_target, 0);
  assert.equal(stored[1].reference_role, 'FRAMEWORK_DEPENDENCY');

  // Clean up
  dbRun('DELETE FROM tasks WHERE id = ?', [testTaskId]);
});

test('27. Idempotent audit persistence: calling persistRepositoryReferences multiple times does not duplicate rows', () => {
  const testTaskId = randomUUID();
  const testProjectId = '2a380312-60c7-4fe5-9046-a49ecb487cbd';

  dbRun(
    `INSERT INTO tasks (id, project_id, prompt, status, workflow_status, execution_status, created_at)
     VALUES (?, ?, 'idempotent test', 'queued', 'queued', 'queued', datetime('now'))`,
    [testTaskId, testProjectId]
  );

  const references = [
    { role: 'STARTER', url: 'https://github.com/lukman-ss/ballo-starter', canonical: 'github.com/lukman-ss/ballo-starter', target: false, source: 'starter_context' }
  ];

  ProjectContextResolver.persistRepositoryReferences(testTaskId, testProjectId, references, 'PASS', null);
  ProjectContextResolver.persistRepositoryReferences(testTaskId, testProjectId, references, 'PASS', null);

  const stored = ProjectContextResolver.getPersistedReferences(testTaskId);
  assert.equal(stored.length, 1);

  // Clean up
  dbRun('DELETE FROM tasks WHERE id = ?', [testTaskId]);
});

test('28. Task recovery unblocks false repository mismatch tasks without re-executing OpenCode', async () => {
  // Ensure pending approval exists for test task
  const existingPending = dbGetOne(
    "SELECT id FROM git_approval_requests WHERE task_id = 'fcf39f35-a8a8-41d6-b0c7-f086510f8a29' AND status = 'pending'"
  );
  if (!existingPending) {
    dbRun(
      `INSERT INTO git_approval_requests (id, task_id, project_id, repository_identity, target_branch, reviewed_revision, status, created_at)
       VALUES (?, 'fcf39f35-a8a8-41d6-b0c7-f086510f8a29', '2a380312-60c7-4fe5-9046-a49ecb487cbd', 'git@github.com:lukman-ss/ballo-todo.git', 'main', 'HEAD', 'pending', datetime('now'))`,
      [randomUUID()]
    );
  }

  // Test taskId fcf39f35-a8a8-41d6-b0c7-f086510f8a29 has execution completed
  const res = await recoverRepositoryMismatchTask('fcf39f35-a8a8-41d6-b0c7-f086510f8a29');
  assert.equal(res.recovered, true);
  assert.equal(res.taskId, 'fcf39f35-a8a8-41d6-b0c7-f086510f8a29');
  assert.equal(res.workflow_status, 'awaiting_approval');
  assert.equal(res.workflowResult.action, 'preserved_pending_approval');
});

test('29. Existing Gate 3 pending approval is preserved and not duplicated or bypassed during recovery', async () => {
  const existingApprovals = dbGet(
    "SELECT * FROM git_approval_requests WHERE task_id = 'fcf39f35-a8a8-41d6-b0c7-f086510f8a29' AND status = 'pending'"
  );
  assert.ok(existingApprovals.length >= 1);

  const approvalIdBefore = existingApprovals[0].id;
  await recoverRepositoryMismatchTask('fcf39f35-a8a8-41d6-b0c7-f086510f8a29');

  const afterApprovals = dbGet(
    "SELECT * FROM git_approval_requests WHERE task_id = 'fcf39f35-a8a8-41d6-b0c7-f086510f8a29' AND status = 'pending'"
  );
  assert.equal(afterApprovals.length, existingApprovals.length);
  assert.equal(afterApprovals[0].id, approvalIdBefore);
});

test('30. Task recovery fails closed when genuine SCOPE_CONFLICT is detected', async () => {
  const conflictTaskId = randomUUID();
  const testProjectId = '2a380312-60c7-4fe5-9046-a49ecb487cbd'; // ballo-todo

  dbRun(
    `INSERT INTO tasks (id, project_id, prompt, status, workflow_status, execution_status, created_at)
     VALUES (?, ?, ?, 'blocked', 'blocked', 'completed', datetime('now'))`,
    [conflictTaskId, testProjectId, 'modify repository directly: https://github.com/lukman-ss/ballo-starter.git']
  );

  await assert.rejects(
    async () => {
      await recoverRepositoryMismatchTask(conflictTaskId);
    },
    /Cannot recover task: Scope conflict/i
  );

  // Clean up
  dbRun('DELETE FROM tasks WHERE id = ?', [conflictTaskId]);
});

// ============================================================================
// Group 6: Strict Pre-Execution Boundary & Negative Cases (Tests 31–35)
// ============================================================================

test('31. Rejects repository URL without owner or repository name with clear error', () => {
  const withoutRepo = validateGitHubUrl('https://github.com/lukman-ss');
  assert.equal(withoutRepo.valid, false);
  assert.match(withoutRepo.error, /Unsupported repository URL/);

  const emptyOwner = validateGitHubUrl('https://github.com//ballo-todo');
  assert.equal(emptyOwner.valid, false);

  const missingSshOwner = validateGitHubUrl('git@github.com:ballo-todo.git');
  assert.equal(missingSshOwner.valid, false);
});

test('32. Ambiguous repository input does not silently switch or guess target repository', () => {
  const project = {
    id: 'proj-ballo-todo',
    slug: 'ballo-todo',
    name: 'ballo-todo',
    workspace_path: '/tmp/workspace/ballo-todo',
    repository_url: 'git@github.com:lukman-ss/ballo-todo.git'
  };

  const ambiguousText = 'Look at https://github.com/lukman-ss/ballo and https://github.com/lukman-ss/ballo-starter';
  const context = ProjectContextResolver.resolveProjectContext({
    project,
    promptText: ambiguousText
  });

  // Neither is an action directive, so registered target remains unchanged
  assert.equal(context.execution.allowed, true);
  assert.equal(context.project.canonical_repository, 'github.com/lukman-ss/ballo-todo');
  for (const ref of context.repository_references) {
    assert.equal(ref.target, false);
  }
});

test('33. createTask rejects scope conflict before task row or session is committed', () => {
  const testProjectId = '2a380312-60c7-4fe5-9046-a49ecb487cbd';

  assert.throws(
    () => {
      createTask(testProjectId, {
        prompt: 'modify repository directly: https://github.com/lukman-ss/ballo-starter.git\npush changes'
      });
    },
    /Scope conflict/i
  );
});

test('34. Supervisor.createJob rejects scope conflict before job or subtasks are scheduled', async () => {
  const testProjectId = '2a380312-60c7-4fe5-9046-a49ecb487cbd';

  await assert.rejects(
    async () => {
      await Supervisor.createJob(
        testProjectId,
        'modify repository directly: https://github.com/lukman-ss/ballo-starter.git\npush changes'
      );
    },
    /Scope conflict/i
  );
});

test('35. Validation failure produces no file system mutations or side effects in workspace', () => {
  const project = {
    id: 'proj-ballo-todo',
    slug: 'ballo-todo',
    name: 'ballo-todo',
    workspace_path: '/tmp/nonexistent-validation-test-path',
    repository_url: 'git@github.com:lukman-ss/ballo-todo.git'
  };

  const maliciousPrompt = 'target repo: https://github.com/lukman-ss/malicious-target.git';
  const context = ProjectContextResolver.resolveProjectContext({
    project,
    promptText: maliciousPrompt
  });

  assert.equal(context.execution.allowed, false);
  assert.equal(context.execution.validation_result, 'SCOPE_CONFLICT');
  // Workspace path was never created or modified
  assert.equal(existsSync('/tmp/nonexistent-validation-test-path'), false);
});

