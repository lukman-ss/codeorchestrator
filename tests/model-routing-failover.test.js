import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry } from '../src/services/model-registry.js';
import { TaskIntelligence } from '../src/services/task-intelligence.js';
import { ModelResolver } from '../src/services/model-resolver.js';
import { ModelFailover } from '../src/services/model-failover.js';
import { ModelRouter } from '../src/services/model-router.js';
import { dbGetOne, dbGet, dbRun, init } from '../src/database/db.js';

init();

test('1. Model Discovery: Discover actual configured models from OpenCode CLI', () => {
  const models = ModelRegistry.discoverModels({ forceRefresh: true });
  assert.ok(Array.isArray(models));
  assert.ok(models.length > 0);
  const ids = models.map(m => m.id);
  assert.ok(ids.includes('9router/ayce-combo'));
  assert.ok(ids.some(id => id.includes('claude') || id.includes('gemini') || id.includes('free')));
});

test('2. Model Discovery: Parse and format OpenCode model identifiers cleanly', () => {
  const p1 = ModelRegistry.parseModelString('9router/ayce-combo');
  assert.equal(p1.baseModel, '9router/ayce-combo');
  assert.equal(p1.variant, null);

  const p2 = ModelRegistry.parseModelString('9router/ayce-combo#high');
  assert.equal(p2.baseModel, '9router/ayce-combo');
  assert.equal(p2.variant, 'high');

  const p3 = ModelRegistry.parseModelString('9router/ayce-combo#high#high');
  assert.equal(p3.baseModel, '9router/ayce-combo');
  assert.equal(p3.variant, 'high');

  const f1 = ModelRegistry.formatOpenCodeModel('9router/ayce-combo', 'high');
  assert.equal(f1, '9router/ayce-combo#high');

  // Prevent double hashes
  const f2 = ModelRegistry.formatOpenCodeModel('9router/ayce-combo#high', 'low');
  assert.equal(f2, '9router/ayce-combo#low');
});

test('3. Model Discovery: Circuit breaker trips on consecutive provider failures and blocks selection', () => {
  const testModel = 'opencode/circuit-test-model';
  dbRun(`INSERT OR REPLACE INTO model_registry (id, provider, availability_status, health_status, consecutive_failures)
         VALUES (?, 'test', 'available', 'healthy', 0)`, [testModel]);

  assert.equal(ModelRegistry.isCircuitBreakerOpen(testModel), false);

  // Record 3 provider failures
  ModelRegistry.recordExecutionFailure(testModel, 'infrastructure', true);
  ModelRegistry.recordExecutionFailure(testModel, 'infrastructure', true);
  ModelRegistry.recordExecutionFailure(testModel, 'infrastructure', true);

  assert.equal(ModelRegistry.isCircuitBreakerOpen(testModel), true);

  // Recovery resets circuit breaker
  ModelRegistry.recordExecutionSuccess(testModel);
  assert.equal(ModelRegistry.isCircuitBreakerOpen(testModel), false);
});

test('4. Task Intelligence: Simple Q&A vs Complex Architecture vs Multi-Module Tasks', () => {
  // Simple question
  const simple = TaskIntelligence.analyzeTask({ prompt: 'Explain how Goroutines communicate via channels.' });
  assert.equal(simple.category, 'technical_qa');
  assert.equal(simple.complexity, 'low');
  assert.equal(simple.suggestedEffort, 'low');

  // Short but complex instruction
  const shortComplex = TaskIntelligence.analyzeTask({ prompt: 'Fix distributed deadlock in raft consensus cluster.' });
  assert.equal(shortComplex.category, 'debugging');
  assert.ok(shortComplex.complexityScore >= 30);
  assert.ok(['medium', 'high'].includes(shortComplex.complexity));

  // Multi-module implementation with high requirement count
  const multiModule = TaskIntelligence.analyzeTask({
    prompt: `Build a complete Todo web application using Ballo Starter.
    Implement:
    - Authentication
    - Todo CRUD
    - Categories
    - PostgreSQL persistence
    - REST API
    - Responsive UI
    - Unit tests
    - Integration tests`
  });
  assert.equal(multiModule.category, 'source_implementation');
  assert.equal(multiModule.complexity, 'high');
  assert.equal(multiModule.suggestedEffort, 'high');
  assert.ok(multiModule.requiredCapabilities.includes('code_generation'));
  assert.ok(multiModule.requiredCapabilities.includes('code_reasoning'));

  // Security task
  const sec = TaskIntelligence.analyzeTask({ prompt: 'Audit the source code for secret leak and authentication bypass vulnerability.' });
  assert.equal(sec.category, 'security_review');
  assert.ok(['medium', 'high'].includes(sec.risk));
  assert.equal(sec.suggestedEffort, 'high');
});

test('5. Model Selection: Autonomous selection does NOT force ayce-combo for every task', () => {
  // Simple technical Q&A prefers economical/fast models (e.g. gemini flash or free models)
  const planSimple = ModelResolver.resolveExecutionPlan({
    prompt: 'Explain Go interface syntax',
    role: 'worker'
  });
  assert.notEqual(planSimple.openCodeModel, '9router/ayce-combo#high');
  assert.equal(planSimple.effort, 'low');

  // Complex multi-module selects high reasoning worker
  const planComplex = ModelResolver.resolveExecutionPlan({
    prompt: `Build a fullstack microservice in Go.
    - REST API
    - PostgreSQL
    - Redis Cache
    - Unit tests
    - Docker container
    - CI/CD workflow
    - Authentication
    - Authorization`,
    role: 'worker'
  });
  assert.equal(planComplex.complexity, 'high');
  assert.equal(planComplex.effort, 'high');
  assert.ok(planComplex.openCodeModel.includes('#high'));
});

test('6. Multi-Agent Roles: Auditor independence and role-specific models', () => {
  const auditPlan = ModelResolver.resolveExecutionPlan({
    prompt: 'Audit the repository for security vulnerabilities and criteria compliance',
    role: 'auditor'
  });
  assert.equal(auditPlan.role, 'auditor');
  assert.ok(auditPlan.model.includes('claude') || auditPlan.model.includes('ayce'));

  const supervisorPlan = ModelResolver.resolveExecutionPlan({
    prompt: 'Plan the architectural decomposition of this service',
    role: 'supervisor'
  });
  assert.equal(supervisorPlan.role, 'supervisor');

  const repairPlan = ModelResolver.resolveExecutionPlan({
    prompt: 'Fix failing unit test in auth_test.go',
    role: 'repair'
  });
  assert.equal(repairPlan.role, 'repair');
});

test('7. Reasoning Effort: Variants parsed, validated, and normalized safely', () => {
  // xhigh requested on model supporting high -> safe fallback to high
  const v1 = ModelRegistry.validateVariant('9router/ayce-combo', 'xhigh');
  assert.equal(v1, 'high');

  // low validated on model supporting low
  const v2 = ModelRegistry.validateVariant('9router/ayce-combo', 'low');
  assert.equal(v2, 'low');

  // formatOpenCodeModel produces exact provider/model#variant syntax
  const formatted = ModelRegistry.formatOpenCodeModel('9router/ayce-combo', 'high');
  assert.equal(formatted, '9router/ayce-combo#high');
});

test('8. Failover: Failure classification correctly separates categories', () => {
  const c1 = ModelFailover.classifyFailure({ error: 'fetch failed: ECONNRESET' });
  assert.equal(c1.category, 'infrastructure');
  assert.equal(c1.recoverable, true);

  const c2 = ModelFailover.classifyFailure({ stderr: 'HTTP 429 Too Many Requests (Rate limit)' });
  assert.equal(c2.category, 'rate_limit');
  assert.equal(c2.recoverable, true);

  const c3 = ModelFailover.classifyFailure({ stderr: 'tool call failed: model does not support tools' });
  assert.equal(c3.category, 'capability');
  assert.equal(c3.recoverable, true);

  const c4 = ModelFailover.classifyFailure({ stderr: 'AssertionError: expected true but got false', auditVerdict: 'FAILED' });
  assert.equal(c4.category, 'reasoning');
  assert.equal(c4.recoverable, true);

  const c5 = ModelFailover.classifyFailure({ error: 'ENOENT: no such file or directory /workspace/repo' });
  assert.equal(c5.category, 'environment');
  assert.equal(c5.recoverable, false);

  const c6 = ModelFailover.classifyFailure({ findings: [{ severity: 'CRITICAL', category: 'secret_exposure' }] });
  assert.equal(c6.category, 'security');
  assert.equal(c6.recoverable, false);
});

test('9. Failover: Recovery hierarchy (Retry -> Effort Escalation -> Model Switch -> Bounded Halt)', () => {
  // Transient infrastructure -> retry same model
  const r1 = ModelFailover.planRecovery({
    taskId: 't1',
    currentModel: '9router/ayce-combo',
    currentEffort: 'medium',
    failureClassification: { category: 'infrastructure', recoverable: true, reason: 'Network timeout' }
  });
  assert.equal(r1.strategy, 'retry');
  assert.equal(r1.openCodeModel, '9router/ayce-combo#medium');

  // Reasoning failure at medium effort -> escalate to high
  const r2 = ModelFailover.planRecovery({
    taskId: 't2',
    currentModel: '9router/ayce-combo',
    currentEffort: 'medium',
    failureClassification: { category: 'reasoning', recoverable: true, reason: 'Tests failed' }
  });
  assert.equal(r2.strategy, 'increase_effort');
  assert.equal(r2.nextEffort, 'high');
  assert.equal(r2.openCodeModel, '9router/ayce-combo#high');

  // Reasoning failure at high effort -> switch model
  const r3 = ModelFailover.planRecovery({
    taskId: 't3',
    currentModel: '9router/ayce-combo',
    currentEffort: 'high',
    failureClassification: { category: 'reasoning', recoverable: true, reason: 'Repeated logic error' },
    fallbackCandidates: ['9router/ag/claude-sonnet-4-6']
  });
  assert.equal(r3.strategy, 'switch_model');
  assert.equal(r3.nextModel, '9router/ag/claude-sonnet-4-6');
  assert.ok(r3.openCodeModel.includes('claude-sonnet-4-6'));

  // Exceeded bound -> Halt
  const r4 = ModelFailover.planRecovery({
    taskId: 't4',
    currentModel: '9router/ayce-combo',
    currentEffort: 'high',
    failureClassification: { category: 'reasoning', recoverable: true, reason: 'Limit reached' },
    attemptCount: 4,
    switchCount: 2
  });
  assert.equal(r4.strategy, 'blocked');
  assert.equal(r4.action, 'HALT');
});

test('10. Context Preservation: Durable handoff artifact preserves requirements and workspace state', () => {
  const artifact = ModelFailover.buildHandoffArtifact({
    taskId: 'task-100',
    projectId: 'proj-100',
    previousModel: '9router/ayce-combo',
    previousEffort: 'high',
    nextModel: '9router/ag/claude-sonnet-4-6',
    nextEffort: 'high',
    failureReason: 'Assertion error in user_service_test.go',
    originalPrompt: 'Build User Management Service',
    filesChanged: ['service.go', 'user.go'],
    failedCriteria: ['Criterion 2: password must be hashed']
  });

  assert.equal(artifact.handoff.taskId, 'task-100');
  assert.equal(artifact.handoff.previousModel, '9router/ayce-combo');
  assert.equal(artifact.handoff.nextModel, '9router/ag/claude-sonnet-4-6');
  assert.ok(artifact.recoveryPrompt.includes('Original Task ID: task-100'));
  assert.ok(artifact.recoveryPrompt.includes('password must be hashed'));
  assert.ok(artifact.recoveryPrompt.includes('Build User Management Service'));
});

test('11. Database: Routing decisions, attempts, failovers, and performance history persist', () => {
  // Check routing decisions table
  const decision = dbGetOne('SELECT * FROM model_routing_decisions ORDER BY created_at DESC LIMIT 1');
  assert.ok(decision);
  assert.ok(decision.selected_model);
  assert.ok(decision.opencode_model);

  // Check execution attempts recording
  const attemptId = ModelRouter.recordExecutionAttempt({
    taskId: null,
    modelId: '9router/ayce-combo',
    openCodeModel: '9router/ayce-combo#high',
    verificationOutcome: 'success',
    inputTokens: 500,
    outputTokens: 250
  });
  assert.ok(attemptId);
  const row = dbGetOne('SELECT * FROM model_execution_attempts WHERE id = ?', [attemptId]);
  assert.equal(row.verification_outcome, 'success');
  assert.equal(row.input_tokens, 500);

  // Check performance history update
  ModelRouter.recordOutcome({
    modelId: '9router/ayce-combo',
    category: 'testing',
    verified: true,
    tokens: 750
  });
  const perf = dbGetOne('SELECT * FROM model_performance_history WHERE model_id = ? AND category = ?', ['9router/ayce-combo', 'testing']);
  assert.ok(perf);
  assert.ok(perf.verified_successes >= 1);
});
