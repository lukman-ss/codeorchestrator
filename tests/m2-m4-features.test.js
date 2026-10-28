import { test } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalService } from '../src/services/approval-service.js';
import { KnowledgeService } from '../src/services/knowledge-service.js';
import { ModelRouter } from '../src/services/model-router.js';
import { createProject, importProject } from '../src/services/project-service.js';
import { WorkflowService } from '../src/services/workflow-service.js';
import { startTestServer } from './test-helper.js';

function makeTempGitRepo(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test Runner"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), '# Test\n');
  execSync('git add README.md && git commit -m "initial commit"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

test('ApprovalService: create_pr decision creates branch and PR contract cleanly', async () => {
  const slug = `test-pr-${Date.now()}`;
  const project = createProject({
    name: slug,
    slug,
    initGit: true,
    isTest: 1,
    creatorUserId: '1558026964365873202'
  });
  const repo = project.workspace_path;

  writeFileSync(join(repo, 'new-feature.txt'), 'pr feature content\n');

  const wf = await WorkflowService.startCompletionWorkflow({
    projectId: project.id,
    prompt: 'Implement PR feature',
    taskFiles: ['new-feature.txt']
  });

  assert.equal(wf.status, 'awaiting_approval');
  const approvalId = wf.approvalId;

  const decisionRes = await ApprovalService.processDecision({
    approvalRequestId: approvalId,
    userId: '1558026964365873202',
    decision: 'create_pr',
    prOptions: {
      featureBranch: `feature/pr-test-${Date.now()}`
    }
  });

  assert.equal(decisionRes.success, true);
  assert.equal(decisionRes.decision, 'create_pr');
  assert.ok(decisionRes.prUrl);
  assert.ok(decisionRes.branchName);

  const updatedApproval = ApprovalService.getApprovalRequest(approvalId);
  assert.equal(updatedApproval.status, 'approved_pr');

  rmSync(repo, { recursive: true, force: true });
});

test('KnowledgeService: Scope isolation, provenance, and context compilation', async () => {
  const projA = createProject({ name: `know-a-${Date.now()}`, slug: `know-a-${Date.now()}`, initGit: true, isTest: 1 });
  const projB = createProject({ name: `know-b-${Date.now()}`, slug: `know-b-${Date.now()}`, initGit: true, isTest: 1 });

  // Create project A knowledge
  const entryA = KnowledgeService.createEntry({
    scope: 'project',
    projectId: projA.id,
    title: 'PostgreSQL DB Connection',
    content: 'All database queries must use connection pool with SSL.',
    classification: 'architecture',
    sourceRevision: 'abcd1234'
  });

  assert.ok(entryA.id);
  assert.equal(entryA.project_id, projA.id);

  // Create global entry
  const entryGlobal = KnowledgeService.createEntry({
    scope: 'global',
    title: 'Global Security Rules',
    content: 'Never commit credentials.',
    classification: 'convention'
  });

  // Query project A: must see project A + global, but NOT project B
  const listA = KnowledgeService.listEntries({ projectId: projA.id });
  const idsA = listA.map(e => e.id);
  assert.ok(idsA.includes(entryA.id));
  assert.ok(idsA.includes(entryGlobal.id));

  // Query project B: must NOT see project A
  const listB = KnowledgeService.listEntries({ projectId: projB.id });
  const idsB = listB.map(e => e.id);
  assert.ok(!idsB.includes(entryA.id));
  assert.ok(idsB.includes(entryGlobal.id));

  // Context prompt compilation
  const promptText = KnowledgeService.compileContextPrompt({ projectId: projA.id });
  assert.ok(promptText.includes('PostgreSQL DB Connection'));
  assert.ok(promptText.includes('Global Security Rules'));

  // Invalidate stale revisions
  const invalidated = KnowledgeService.invalidateStale(projA.id, 'ef019876');
  assert.equal(invalidated, 1);
  const updatedEntryA = KnowledgeService.getEntry(entryA.id);
  assert.equal(updatedEntryA.validation_status, 'stale');

  rmSync(projA.workspace_path, { recursive: true, force: true });
  rmSync(projB.workspace_path, { recursive: true, force: true });
});

test('ModelRouter: Resolves category policies, records usage, and pauses on budget exhaustion', async () => {
  ModelRouter.initDefaultPolicies();

  const policy = ModelRouter.resolveModel('security_review');
  assert.ok(policy.model);
  assert.equal(policy.category, 'security_review');

  const budgetScopeId = `test-user-${Date.now()}`;
  ModelRouter.setBudget({
    scope: 'user',
    scopeId: budgetScopeId,
    maxTokens: 500,
    maxCostUsd: 1.0,
    status: 'active'
  });

  const check1 = ModelRouter.checkBudget({ scope: 'user', scopeId: budgetScopeId, estimatedTokens: 100 });
  assert.equal(check1.allowed, true);

  // Record usage exceeding the 500 token budget
  ModelRouter.recordUsage({
    userId: budgetScopeId,
    model: 'test/model',
    category: 'source_implementation',
    inputTokens: 300,
    outputTokens: 250,
    estimatedCostUsd: 0.05
  });

  const check2 = ModelRouter.checkBudget({ scope: 'user', scopeId: budgetScopeId, estimatedTokens: 10 });
  assert.equal(check2.allowed, false);
  assert.ok(check2.reason.includes('exhausted'));
});

test('Operational Dashboard: /metrics and /dashboard render real state', async () => {
  const serverContext = await startTestServer();
  try {
    const metricsRes = await fetch(`${serverContext.baseUrl}/metrics`);
    const metricsText = await metricsRes.text();
    assert.equal(metricsRes.status, 200);
    assert.ok(metricsText.includes('orchestrator_uptime_seconds'));
    assert.ok(metricsText.includes('orchestrator_disk_available_bytes'));
    assert.ok(metricsText.includes('orchestrator_active_tasks'));

    const dashRes = await fetch(`${serverContext.baseUrl}/dashboard`);
    const dashText = await dashRes.text();
    assert.equal(dashRes.status, 200);
    assert.ok(dashText.includes('CodeOrchestrator Operational Dashboard'));
    assert.ok(dashText.includes('System Uptime'));
    assert.ok(dashText.includes('Active Workers'));
  } finally {
    await serverContext.cleanup();
  }
});
