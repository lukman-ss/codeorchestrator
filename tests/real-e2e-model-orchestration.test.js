import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer } from './test-helper.js';
import { ModelResolver } from '../src/services/model-resolver.js';
import { ModelFailover } from '../src/services/model-failover.js';
import { ModelRegistry } from '../src/services/model-registry.js';
import { TaskIntelligence } from '../src/services/task-intelligence.js';

let serverContext;
let BASE;
let TOKEN;

before(async () => {
  serverContext = await startTestServer();
  BASE = serverContext.baseUrl;
  TOKEN = serverContext.token;
});

after(async () => {
  if (serverContext) {
    await serverContext.cleanup();
  }
});

function request(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
      ...(opts.headers || {})
    };
    const req = http.request(url, { ...opts, headers }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

test('Scenario A — Simple Question Autonomous Selection & Execution Plan', async () => {
  const prompt = 'Explain the purpose of a Go interface.';
  const plan = ModelResolver.resolveExecutionPlan({
    prompt,
    role: 'worker'
  });

  assert.equal(plan.category, 'technical_qa');
  assert.equal(plan.complexity, 'low');
  assert.equal(plan.effort, 'low');
  assert.notEqual(plan.openCodeModel, '9router/ayce-combo#high');
  assert.ok(plan.decisionId);
  assert.ok(plan.reason);
});

test('Scenario B — Complex Coding Task Autonomous Selection & Effort Escalation', async () => {
  const prompt = `Build a complete Todo web application using Ballo Starter.
Implement:
- Authentication
- Todo CRUD
- Categories
- PostgreSQL persistence
- REST API
- Responsive UI
- Unit tests
- Integration tests`;

  const plan = ModelResolver.resolveExecutionPlan({
    prompt,
    role: 'worker'
  });

  assert.equal(plan.category, 'source_implementation');
  assert.equal(plan.complexity, 'high');
  assert.equal(plan.effort, 'high');
  assert.ok(plan.openCodeModel.includes('#high'));
  assert.ok(plan.requiredCapabilities.includes('code_generation'));
  assert.ok(plan.requiredCapabilities.includes('code_reasoning'));
});

test('Scenario C — Unsupported Model Fallback to Verified Candidate', async () => {
  const plan = ModelResolver.resolveExecutionPlan({
    prompt: 'Implement a quicksort algorithm in Python',
    preferredModel: 'fictitious-provider/non-existent-super-model-v99',
    role: 'worker'
  });

  // Fictitious model rejected and falling back to approved model
  assert.notEqual(plan.model, 'fictitious-provider/non-existent-super-model-v99');
  assert.ok(plan.model.includes('9router') || plan.model.includes('opencode'));
  assert.ok(plan.reason.includes('unavailable') || plan.reason.includes('falling back') || plan.reason.includes('fallback'));
});

test('Scenario D — Reasoning Escalation on Verified Verification Failure', async () => {
  const currentModel = '9router/ayce-combo';
  const currentEffort = 'medium';
  const failure = ModelFailover.classifyFailure({
    auditVerdict: 'FAILED',
    stderr: 'AssertionError: Expected 200 OK, got 500 Internal Server Error'
  });

  assert.equal(failure.category, 'reasoning');
  assert.equal(failure.recoverable, true);

  const recovery = ModelFailover.planRecovery({
    taskId: 'task-scenario-d',
    currentModel,
    currentEffort,
    failureClassification: failure
  });

  assert.equal(recovery.strategy, 'increase_effort');
  assert.equal(recovery.nextEffort, 'high');
  assert.equal(recovery.openCodeModel, '9router/ayce-combo#high');
});

test('Scenario E — Model Switch with Context Handoff Artifact', async () => {
  const currentModel = '9router/ayce-combo';
  const currentEffort = 'high';
  const failure = ModelFailover.classifyFailure({
    auditVerdict: 'FAILED',
    stderr: 'Repeated structural logic failure in transaction management'
  });

  const recovery = ModelFailover.planRecovery({
    taskId: 'task-scenario-e',
    currentModel,
    currentEffort,
    failureClassification: failure,
    fallbackCandidates: ['9router/ag/claude-sonnet-4-6']
  });

  assert.equal(recovery.strategy, 'switch_model');
  assert.equal(recovery.nextModel, '9router/ag/claude-sonnet-4-6');
  assert.ok(recovery.openCodeModel.includes('claude-sonnet-4-6'));

  const artifact = ModelFailover.buildHandoffArtifact({
    taskId: 'task-scenario-e',
    projectId: 'proj-scenario-e',
    previousModel: currentModel,
    previousEffort: currentEffort,
    nextModel: recovery.nextModel,
    nextEffort: recovery.nextEffort,
    failureReason: failure.reason,
    originalPrompt: 'Implement distributed 2PC coordinator',
    filesChanged: ['coordinator.go'],
    failedCriteria: ['Handle node crash before commit ack']
  });

  assert.equal(artifact.handoff.taskId, 'task-scenario-e');
  assert.equal(artifact.handoff.nextModel, '9router/ag/claude-sonnet-4-6');
  assert.ok(artifact.recoveryPrompt.includes('coordinator.go'));
  assert.ok(artifact.recoveryPrompt.includes('Handle node crash before commit ack'));
});

test('Scenario F — Multi-Agent Role Autonomy & Independence', async () => {
  const supervisorPlan = ModelResolver.resolveExecutionPlan({
    prompt: 'Decompose the migration task into subtasks',
    role: 'supervisor'
  });
  const workerPlan = ModelResolver.resolveExecutionPlan({
    prompt: 'Implement the database migration schema',
    role: 'worker'
  });
  const auditorPlan = ModelResolver.resolveExecutionPlan({
    prompt: 'Audit the database migration for data loss and foreign key constraints',
    role: 'auditor'
  });

  assert.equal(supervisorPlan.role, 'supervisor');
  assert.equal(workerPlan.role, 'worker');
  assert.equal(auditorPlan.role, 'auditor');
  assert.ok(auditorPlan.model.includes('claude') || auditorPlan.model.includes('ayce'));
});

test('Scenario G — Task Creation via REST API with Autonomous Routing and Decision Persistence', async () => {
  const pRes = await request('/projects', {
    method: 'POST',
    body: { name: 'E2E Scenario G Project', slug: `e2e-scen-g-${Date.now()}` }
  });
  assert.equal(pRes.status, 201);
  const proj = pRes.json();

  // Create task WITHOUT specifying model -> autonomous router handles it
  const tRes = await request(`/projects/${proj.id}/tasks`, {
    method: 'POST',
    body: { prompt: 'Write a Fibonacci sequence generator function in Go' }
  });
  assert.equal(tRes.status, 201);
  const task = tRes.json();
  assert.ok(task.id);

  // Check decisions API
  const dRes = await request('/api/models/decisions');
  assert.equal(dRes.status, 200);
  const decisions = dRes.json();
  assert.ok(Array.isArray(decisions));

  // Check registry API
  const rRes = await request('/api/models/registry');
  assert.equal(rRes.status, 200);
  const reg = rRes.json();
  assert.ok(Array.isArray(reg));
  assert.ok(reg.some(m => m.id === '9router/ayce-combo'));
});
