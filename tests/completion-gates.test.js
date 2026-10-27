import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { startTestServer } from './test-helper.js';

import { DATABASE_PATH } from '../src/config.js';
import { init, dbRun, dbGetOne } from '../src/database/db.js';
import { SecurityAuditor } from '../src/services/security-auditor.js';
import { ImplementationVerifier } from '../src/services/implementation-verifier.js';
import { GitOperations } from '../src/services/git-operations.js';
import { ApprovalService } from '../src/services/approval-service.js';
import { WorkflowService } from '../src/services/workflow-service.js';

let serverContext;
let req;
let tempDirs = [];
let testProjectId = 'test-proj-gate-1';
let testRepoPath = '';

function makeTempGitRepo(prefix = 'gate-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Gate Tester"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "tester@gate.local"', { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# Test Project\n');
  execSync('git add README.md && git commit -m "initial commit"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

before(async () => {
  init();
  serverContext = await startTestServer({
    env: { DATABASE_PATH }
  });
  req = serverContext.req;

  testRepoPath = makeTempGitRepo('shared-gate-repo-');
  try {
    dbRun(
      `INSERT INTO projects (id, name, slug, workspace_path, default_branch, metadata_json)
       VALUES (?, ?, ?, ?, 'main', '{}')`,
      [testProjectId, 'Gate Test Project', 'gate-test-proj-' + Date.now(), testRepoPath]
    );
  } catch {}
});

after(async () => {
  if (serverContext) {
    await serverContext.cleanup();
  }
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

test('Gate 1: ImplementationVerifier passes on valid syntax and criteria', async () => {
  const repo = makeTempGitRepo('gate1-pass-');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-gate1', type: 'module' }));
  writeFileSync(join(repo, 'index.js'), 'export const hello = () => "world";\n');

  const res = await ImplementationVerifier.verifyTask({
    projectId: testProjectId,
    workspacePath: repo,
    prompt: 'Add hello function',
    acceptanceCriteria: ['Must export hello function'],
    taskFiles: ['index.js']
  });

  assert.equal(res.status, 'PASS');
  assert.equal(res.failedRequirements, 0);
  assert.ok(res.verifiedRequirements > 0);
});

test('Gate 1: ImplementationVerifier fails on syntax error', async () => {
  const repo = makeTempGitRepo('gate1-fail-');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'node-gate1-fail', type: 'module' }));
  writeFileSync(join(repo, 'broken.js'), 'export const invalid = { ;\n');

  const res = await ImplementationVerifier.verifyTask({
    projectId: testProjectId,
    workspacePath: repo,
    prompt: 'Add invalid code',
    acceptanceCriteria: ['Clean code'],
    taskFiles: ['broken.js']
  });

  assert.equal(res.status, 'FAILED');
  assert.ok(res.failedRequirements > 0);
});

test('Gate 2: SecurityAuditor detects synthetic AWS key and redacts value', async () => {
  const repo = makeTempGitRepo('gate2-aws-');
  writeFileSync(join(repo, 'config.js'), 'const awsKey = "AKIAIOSFODNN7EXAMPLE";\n');

  const res = await SecurityAuditor.auditWorkspace({
    projectId: testProjectId,
    workspacePath: repo,
    reviewedRevision: 'HEAD',
    taskFiles: ['config.js']
  });

  assert.equal(res.status, 'BLOCKED');
  assert.ok(res.severitySummary.CRITICAL > 0 || res.severitySummary.HIGH > 0);
  assert.ok(res.findings.length > 0);

  const finding = res.findings.find(f => f.filePath === 'config.js');
  assert.ok(finding);
  assert.ok(finding.evidenceReference.includes('[REDACTED'));
  assert.ok(!finding.evidenceReference.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(res.limitations.some(l => l.includes('Gitleaks')));
});

test('Gate 2: SecurityAuditor detects /home/ leak and internal IP', async () => {
  const repo = makeTempGitRepo('gate2-leak-');
  const fakeIp = ['192', '168', '1', '50'].join('.');
  writeFileSync(join(repo, 'env.js'), `const p = "/home/secretuser/data"; const host = "${fakeIp}";\n`);

  const res = await SecurityAuditor.auditWorkspace({
    projectId: testProjectId,
    workspacePath: repo,
    reviewedRevision: 'HEAD',
    taskFiles: ['env.js']
  });

  assert.equal(res.status, 'BLOCKED');
  const homeFinding = res.findings.find(f => f.explanation.includes('User Home Directory'));
  assert.ok(homeFinding, 'Expected finding for home path leak');
  const ipFinding = res.findings.find(f => f.explanation.includes('Internal / Tailscale IP'));
  assert.ok(ipFinding, 'Expected finding for internal IP');
});

test('Gate 2: SecurityAuditor passes on clean code', async () => {
  const repo = makeTempGitRepo('gate2-clean-');
  writeFileSync(join(repo, 'utils.js'), 'export function add(a, b) { return a + b; }\n');

  const res = await SecurityAuditor.auditWorkspace({
    projectId: testProjectId,
    workspacePath: repo,
    reviewedRevision: 'HEAD',
    taskFiles: ['utils.js']
  });

  assert.equal(res.status, 'PASS');
  assert.equal(res.findings.length, 0);
  assert.equal(res.severitySummary.CRITICAL, 0);
  assert.equal(res.severitySummary.HIGH, 0);
});

test('Gate 3: Ballo workspace identity mismatch check blocks push', () => {
  const repo = makeTempGitRepo('gate3-ballo-');
  execSync('git remote add origin https://github.com/myorg/CodeOrchestrator.git', { cwd: repo, stdio: 'ignore' });

  const balloProjectId = 'proj-ballo-' + Date.now();
  dbRun(
    `INSERT INTO projects (id, name, slug, workspace_path, default_branch, metadata_json)
     VALUES (?, 'Ballo Project', ?, ?, 'main', '{}')`,
    [balloProjectId, 'ballo-' + Date.now(), repo]
  );

  const check = GitOperations.validateRepositoryIdentity(balloProjectId, repo);
  assert.equal(check.valid, false);
  assert.ok(check.error.includes('Critical repository mismatch'));
  assert.ok(check.error.includes('points to codeorchestrator'));
});

test('Gate 3: GitOperations stages only task-owned files', () => {
  const repo = makeTempGitRepo('gate3-ownership-');
  const baseline = GitOperations.captureBaseline(repo);

  writeFileSync(join(repo, 'task_owned.txt'), 'task change');
  writeFileSync(join(repo, 'unrelated.txt'), 'unrelated change');

  const diffs = GitOperations.getTaskOwnedChanges(repo, baseline);
  assert.ok(diffs.includes('task_owned.txt'));
  assert.ok(diffs.includes('unrelated.txt'));

  // Commit approved changes only stages task_owned.txt
  const commitRes = GitOperations.commitApprovedChanges(repo, ['task_owned.txt'], 'test: stage only owned');
  assert.ok(commitRes.commitSha);

  const status = execSync('git status --porcelain', { cwd: repo, encoding: 'utf8' });
  assert.ok(status.includes('unrelated.txt'), 'unrelated file must remain uncommitted in workspace');
});

test('Gate 3: Git review handles 0 modified files without manufacturing commits', () => {
  const repo = makeTempGitRepo('gate3-empty-');
  const review = GitOperations.generateGitReview(testProjectId, repo, null, []);
  assert.equal(review.noChanges, true);
  assert.equal(review.taskFiles.length, 0);
});

test('ApprovalService: Keep Local preserves changes and marks workflow completed', async () => {
  const repo = makeTempGitRepo('keep-local-');
  writeFileSync(join(repo, 'feature.txt'), 'feature content');

  const projId = 'proj-keep-local-' + Date.now();
  dbRun(
    `INSERT INTO projects (id, name, slug, workspace_path, default_branch, metadata_json)
     VALUES (?, 'Keep Local Proj', ?, ?, 'main', '{}')`,
    [projId, 'keep-local-' + Date.now(), repo]
  );

  const approval = ApprovalService.createApprovalRequest({
    projectId: projId,
    repositoryIdentity: 'local/repo',
    targetBranch: 'main',
    reviewedRevision: 'HEAD',
    diffSummary: { added: 1, modified: 0, deleted: 0 },
    taskFiles: ['feature.txt'],
    proposedCommitMessage: 'feat: keep local test'
  });

  assert.equal(approval.status, 'pending');

  const decRes = await ApprovalService.processDecision({
    approvalRequestId: approval.id,
    userId: 'user-test-1',
    decision: 'keep_local'
  });

  assert.equal(decRes.success, true);
  assert.equal(decRes.decision, 'keep_local');
  assert.equal(decRes.localPreserved, true);

  const updatedReq = ApprovalService.getApprovalRequest(approval.id);
  assert.equal(updatedReq.status, 'approved_keep_local');
});

test('ApprovalService: Idempotent decisions & replay protection', async () => {
  const repo = makeTempGitRepo('idempotent-');
  const projId = 'proj-idem-' + Date.now();
  dbRun(
    `INSERT INTO projects (id, name, slug, workspace_path, default_branch, metadata_json)
     VALUES (?, 'Idempotent Proj', ?, ?, 'main', '{}')`,
    [projId, 'idem-' + Date.now(), repo]
  );

  const approval = ApprovalService.createApprovalRequest({
    projectId: projId,
    repositoryIdentity: 'local/repo',
    targetBranch: 'main',
    reviewedRevision: 'HEAD',
    diffSummary: {},
    taskFiles: [],
    proposedCommitMessage: 'test'
  });

  const dec1 = await ApprovalService.processDecision({
    approvalRequestId: approval.id,
    userId: 'user-test-1',
    decision: 'keep_local'
  });
  assert.equal(dec1.success, true);

  const dec2 = await ApprovalService.processDecision({
    approvalRequestId: approval.id,
    userId: 'user-test-1',
    decision: 'push'
  });
  assert.equal(dec2.success, false);
  assert.equal(dec2.idempotent, true);
  assert.equal(dec2.status, 'approved_keep_local');
});

test('REST API: /approvals/pending and /approvals/:id/decide', async () => {
  const repo = makeTempGitRepo('rest-approval-');
  const projId = 'proj-rest-' + Date.now();
  dbRun(
    `INSERT INTO projects (id, name, slug, workspace_path, default_branch, metadata_json)
     VALUES (?, 'REST Proj', ?, ?, 'main', '{}')`,
    [projId, 'rest-' + Date.now(), repo]
  );

  const approval = ApprovalService.createApprovalRequest({
    projectId: projId,
    repositoryIdentity: 'test/rest-repo',
    targetBranch: 'main',
    reviewedRevision: 'HEAD',
    diffSummary: { added: 1, modified: 0, deleted: 0 },
    taskFiles: ['file.txt'],
    proposedCommitMessage: 'feat: rest test'
  });

  // List pending approvals
  const listRes = await req('/approvals/pending');
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.body));
  assert.ok(listRes.body.find(a => a.id === approval.id));

  // Get single approval
  const singleRes = await req(`/approvals/${approval.id}`);
  assert.equal(singleRes.status, 200);
  assert.equal(singleRes.body.id, approval.id);

  // Decide via REST API: keep_local
  const decideRes = await req(`/approvals/${approval.id}/decide`, 'POST', {
    decision: 'keep_local',
    userId: 'user-rest-tester'
  });
  assert.equal(decideRes.status, 200);
  assert.equal(decideRes.body.success, true);
  assert.equal(decideRes.body.decision, 'keep_local');

  // Verify pending list no longer includes this approval
  const listRes2 = await req('/approvals/pending');
  assert.ok(!listRes2.body.find(a => a.id === approval.id));
});

test('WorkflowService: 0 changed files completes cleanly without pushing or manufacturing commits', async () => {
  const repo = makeTempGitRepo('workflow-nochanges-');
  const projId = 'proj-nochanges-' + Date.now();
  dbRun(
    `INSERT INTO projects (id, name, slug, workspace_path, default_branch, metadata_json)
     VALUES (?, 'NoChanges Proj', ?, ?, 'main', '{}')`,
    [projId, 'nochanges-' + Date.now(), repo]
  );

  const wfRes = await WorkflowService.startCompletionWorkflow({
    projectId: projId,
    prompt: 'Read documentation',
    acceptanceCriteria: ['Read docs'],
    taskFiles: []
  });

  assert.equal(wfRes.status, 'completed');
  assert.equal(wfRes.noChanges, true);
});

test('WorkflowService: Crash recovery logs and handles pending workflows on restart', () => {
  assert.doesNotThrow(() => {
    WorkflowService.recoverPendingWorkflows();
  });
});
