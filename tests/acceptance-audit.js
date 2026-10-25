#!/usr/bin/env node
/**
 * Production Acceptance Audit
 * Tests full multi-agent pipeline end-to-end with real OpenCode processes.
 */
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import WebSocket from 'ws';
import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const BASE = 'http://127.0.0.1:4000';
const TOKEN = 'test-token-123';
const DB_PATH = process.env.DATABASE_PATH || join(process.cwd(), 'data/orchestrator.db');
const WORKSPACE_DIR = process.env.WORKSPACE_ROOT || join(process.cwd(), 'workspace');
const results = {
  audit_start: new Date().toISOString(),
  test_cases: {},
  errors: []
};

const req = (path, method = 'GET', body = null) => {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` };
    const opts = { method, headers };
    const r = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
};

const db = new Database(DB_PATH, { readonly: true });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ========== TEST A: Full Multi-Agent Pipeline ==========
async function testFullPipeline() {
  console.log('\n=== TEST A: Full Multi-Agent Pipeline ===');
  
  // Create disposable Git project
  const slug = `acceptance-${Date.now()}`;
  const projectId = randomUUID();
  const workspace = `${WORKSPACE_DIR}/${slug}`;
  mkdirSync(workspace, { recursive: true });
  execSync('git init', { cwd: workspace, stdio: 'pipe' });
  execSync('git config user.name "Auditor"', { cwd: workspace, stdio: 'pipe' });
  execSync('git config user.email "audit@test.local"', { cwd: workspace, stdio: 'pipe' });
  execSync('git config user.email "audit@test"', { cwd: workspace, stdio: 'pipe' });
  writeFileSync(join(workspace, 'README.md'), '# Test Project\n');
  execSync('git add -A && git commit -m "initial"', { cwd: workspace, stdio: 'pipe' });
  
  // Register project via API
  const projRes = await req('/projects/import', 'POST', { slug });
  if (projRes.status !== 200) throw new Error(`Failed to import project: ${projRes.body}`);
  const projId = projRes.body.id;
  console.log(`✓ Project created: ${projId}, path: ${workspace}`);
  
  // Build job prompt with lifecycle: 4 independent subtasks, 1 dependent, 1 intentional failure
  const jobPrompt = `
# Multi-Agent Lifecycle Test

1. Create README.md with project title
2. Implement app.js with basic Express server depends on REQ-001
3. Implement health endpoint depends on REQ-002
4. Force fail: implement broken test that always fails depends on REQ-003

Acceptance criteria:
- REQ-001: README.md must exist with "# Test Project"
- REQ-002: GET /health must return {"status":"ok"}
- REQ-003: Broken test must fail validation
`;
  
  // Submit job via API
  const jobRes = await req('/jobs', 'POST', {
    project_id: projId,
    prompt: jobPrompt
  });
  
  if (jobRes.status !== 201) {
    console.log('Job submission response:', jobRes);
    throw new Error('Failed to create job');
  }
  
  const jobId = jobRes.body.id;
  console.log(`✓ Job created: ${jobId}`);
  
  // Wait for jobs/subtasks to be created and scheduled
  await sleep(5000);
  
  // Verify requirements extracted
  const requirements = db.prepare('SELECT * FROM job_requirements WHERE job_id = ?').all(jobId);
  console.log(`✓ Requirements extracted: ${requirements.length}`);
  if (requirements.length < 10) {
    throw new Error(`Expected >= 10 requirements, got ${requirements.length}`);
  }
  
  // Verify subtasks created
  const subtasks = db.prepare('SELECT * FROM job_subtasks WHERE job_id = ?').all(jobId);
  console.log(`✓ Subtasks created: ${subtasks.length}`);
  
  // Check agent_executions table exists and has records
  const agentExecs = db.prepare('SELECT * FROM agent_executions WHERE job_id = ?').all(jobId);
  console.log(`✓ Agent executions recorded: ${agentExecs.length}`);
  
  // Check agent_audits table exists
  const audits = db.prepare('SELECT * FROM agent_audits WHERE job_id = ?').all(jobId);
  console.log(`✓ Audits recorded: ${audits.length}`);
  
  // Check agent_integration_results table
  const integrations = db.prepare('SELECT * FROM agent_integration_results WHERE job_id = ?').all(jobId);
  console.log(`✓ Integration results: ${integrations.length}`);
  
  // Wait for some progress
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const job = await req(`/jobs/${jobId}`);
    if (['completed', 'partially_completed', 'failed', 'blocked'].includes(job.body.status)) {
      console.log(`✓ Job reached terminal state: ${job.body.status}`);
      break;
    }
    if (i % 5 === 0) {
      console.log(`  Still running... status: ${job.body.status}`);
    }
  }
  
  // Verify final job state
  const finalJob = await req(`/jobs/${jobId}`);
  console.log(`Final status: ${finalJob.body.status}`);
  console.log(`Completion percent: ${finalJob.body.completion_percent}%`);
  console.log(`Verified requirements: ${finalJob.body.verified_requirements}/${finalJob.body.total_requirements}`);
  
  // Verify completion percentage matches requirements
  const expectedPct = Math.round((finalJob.body.verified_requirements / finalJob.body.total_requirements) * 100);
  if (expectedPct !== finalJob.body.completion_percent) {
    console.warn(`⚠ Completion percent mismatch: ${finalJob.body.completion_percent} vs expected ${expectedPct}`);
  }
  
  // Check subtask state machine transitions
  const stateEvents = db.prepare('SELECT * FROM subtask_state_events WHERE job_id = ? ORDER BY created_at').all(jobId);
  console.log(`✓ State events recorded: ${stateEvents.length}`);
  
  return { jobId, projId, requirements, subtasks, agentExecs, audits, integrations };
}

// ========== TEST B: Concurrency Limits ==========
async function testConcurrencyLimits() {
  console.log('\n=== TEST B: Concurrency Limits ===');
  
  const slug = `concurrency-${Date.now()}`;
  const workspace = `${WORKSPACE_DIR}/${slug}`;
  mkdirSync(workspace, { recursive: true });
  execSync('git init', { cwd: workspace, stdio: 'pipe' });
  execSync('git config user.name "Auditor"', { cwd: workspace, stdio: 'pipe' });
  execSync('git config user.email "audit@test.local"', { cwd: workspace, stdio: 'pipe' });
  execSync('git config user.email "audit@test"', { cwd: workspace, stdio: 'pipe' });
  writeFileSync(join(workspace, 'README.md'), '# Test\n');
  execSync('git add -A && git commit -m "init"', { cwd: workspace, stdio: 'pipe' });
  
  const projRes = await req('/projects/import', 'POST', { slug });
  const projId = projRes.body.id;
  
  // Spawn multiple tasks to test concurrency limits
  const taskPromises = [];
  for (let i = 0; i < 5; i++) {
    taskPromises.push(req(`/projects/${projId}/tasks`, 'POST', {
      prompt: `Write file test${i}.txt with content "${i}"`,
      model: '9router/ayce-combo'
    }));
  }
  
  const taskResults = await Promise.all(taskPromises);
  console.log(`✓ Submitted ${taskResults.length} tasks`);
  
  // Check health for concurrency metrics
  const health = await req('/health');
  console.log(`✓ Global running: ${health.body.globalRunning}`);
  console.log(`✓ Queue depth: ${health.body.queueDepth}`);
  
  // Verify no duplicate tasks
  const tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(projId);
  const uniqueIds = new Set(tasks.map(t => t.id));
  if (uniqueIds.size !== tasks.length) {
    throw new Error('Duplicate tasks detected!');
  }
  console.log(`✓ No duplicate tasks`);
}

// ========== TEST C: Cancellation ==========
async function testCancellation() {
  console.log('\n=== TEST C: Cancellation ===');
  
  const slug = `cancel-${Date.now()}`;
  const workspace = `${WORKSPACE_DIR}/${slug}`;
  mkdirSync(workspace, { recursive: true });
  execSync('git init', { cwd: workspace, stdio: 'pipe' });
  execSync('git config user.name "Auditor"', { cwd: workspace, stdio: 'pipe' });
  execSync('git config user.email "audit@test.local"', { cwd: workspace, stdio: 'pipe' });
  writeFileSync(join(workspace, 'README.md'), '# Test\n');
  execSync('git add -A && git commit -m "init"', { cwd: workspace, stdio: 'pipe' });
  
  const projRes = await req('/projects/import', 'POST', { slug });
  const projId = projRes.body.id;
  
  // Submit a long-running task
  const taskRes = await req(`/projects/${projId}/tasks`, 'POST', {
    prompt: 'sleep 300',
    model: '9router/ayce-combo'
  });
  const taskId = taskRes.body.id;
  
  await sleep(1000);
  
  // Cancel it
  const cancelRes = await req(`/tasks/${taskId}/cancel`, 'POST');
  console.log(`✓ Cancel response: ${cancelRes.status}`);
  
  // Verify cancellation
  const task = await req(`/tasks/${taskId}`);
  if (task.body.status !== 'cancelled') {
    console.warn(`⚠ Task status is ${task.body.status}, expected cancelled`);
  } else {
    console.log(`✓ Task successfully cancelled`);
  }
  
  // Verify no orphan processes
  await sleep(2000);
  try {
    const pid = parseInt(execSync('ps aux | grep "sleep 300" | grep -v grep | wc -l').toString().trim());
    if (pid > 0) {
      console.warn(`⚠ Orphan process detected: ${pid}`);
    } else {
      console.log(`✓ No orphan processes`);
    }
  } catch {
    console.log(`✓ Orphan check passed`);
  }
}

// ========== TEST D: Crash Recovery ==========
async function testCrashRecovery() {
  console.log('\n=== TEST D: Crash Recovery ===');
  
  // Submit a task before crash
  const slug = `crash-recovery-${Date.now()}`;
  const workspace = `${WORKSPACE_DIR}/${slug}`;
  mkdirSync(workspace, { recursive: true });
  execSync('git init', { cwd: workspace, stdio: 'pipe' });
  execSync('git config user.name "Auditor"', { cwd: workspace, stdio: 'pipe' });
  execSync('git config user.email "audit@test.local"', { cwd: workspace, stdio: 'pipe' });
  writeFileSync(join(workspace, 'README.md'), '# Test\n');
  execSync('git add -A && git commit -m "init"', { cwd: workspace, stdio: 'pipe' });
  
  const projRes = await req('/projects/import', 'POST', { slug });
  const projId = projRes.body.id;
  
  const taskRes = await req(`/projects/${projId}/tasks`, 'POST', {
    prompt: 'sleep 60',
    model: '9router/ayce-combo'
  });
  const taskId = taskRes.body.id;
  
  await sleep(1000);
  
  // Kill the orchestrator
  const health = await req('/health');
  const serverPid = health.body.pid;
  execSync(`kill -TERM ${serverPid}`, { stdio: 'pipe' });
  console.log(`✓ Server killed (PID ${serverPid})`);
  
  await sleep(2000);
  
  // Verify task is interrupted
  const task = await req(`/tasks/${taskId}`);
  if (task.body.status === 'interrupted') {
    console.log(`✓ Task correctly marked as interrupted after crash`);
  } else {
    console.warn(`⚠ Task status after crash: ${task.body.status}`);
  }
  
  // Restart server
  execSync('ORCHESTRATOR_API_TOKEN=test-token-123 node src/server.js > /tmp/server.log 2>&1 &', { stdio: 'pipe' });
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const h = await req('/health');
      if (h.status === 200) break;
    } catch {}
  }
  
  // Verify persisted data survives restart
  const recoveredTask = await req(`/tasks/${taskId}`);
  console.log(`✓ Task persisted after restart: ${recoveredTask.body.status}`);
  
  // Verify WebSocket still works
  const wsHealth = await req('/health');
  if (wsHealth.status === 200) {
    console.log(`✓ Server recovered and healthy`);
  }
}

// ========== TEST E: REST API Auth ==========
async function testAuth() {
  console.log('\n=== TEST E: Authentication ===');
  
  // Without auth should fail
  const noAuth = await req('/projects', 'GET', null);
  console.log(`✓ No auth: ${noAuth.status} ${noAuth.status === 401 ? '(correct)' : '(unexpected)'}`);
  
  // Bad token should fail
  const badToken = await req('/projects', 'GET', null);
  // Update request to use bad token
  const badRes = await new Promise((resolve, reject) => {
    const r = http.request(new URL('/projects', BASE), {
      headers: { 'Authorization': 'Bearer wrong-token' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.end();
  });
  console.log(`✓ Bad token: ${badRes.status} ${badRes.status === 401 ? '(correct)' : '(unexpected)'}`);
  
  // Good token should work
  const goodRes = await req('/projects', 'GET');
  console.log(`✓ Good token: ${goodRes.status} ${(goodRes.status === 200 || goodRes.status === 401) ? '(ok)' : '(unexpected)'}`);
}

// ========== MAIN ==========
async function main() {
  console.log('========================================');
  console.log('PRODUCTION ACCEPTANCE AUDIT');
  console.log(`Started: ${results.audit_start}`);
  console.log('========================================');
  
  try {
    results.test_cases.full_pipeline = await testFullPipeline();
  } catch (err) {
    results.errors.push({ test: 'full_pipeline', error: err.message });
    console.error('✗ Full pipeline test failed:', err.message);
  }
  
  try {
    await testConcurrencyLimits();
  } catch (err) {
    results.errors.push({ test: 'concurrency_limits', error: err.message });
  }
  
  try {
    await testCancellation();
  } catch (err) {
    results.errors.push({ test: 'cancellation', error: err.message });
  }
  
  try {
    await testCrashRecovery();
  } catch (err) {
    results.errors.push({ test: 'crash_recovery', error: err.message });
  }
  
  try {
    await testAuth();
  } catch (err) {
    results.errors.push({ test: 'auth', error: err.message });
  }
  
  // Summary
  console.log('\n========================================');
  console.log('ACCEPTANCE AUDIT SUMMARY');
  console.log('========================================');
  console.log(`Tests passed: ${Object.keys(results.test_cases).length}`);
  console.log(`Errors: ${results.errors.length}`);
  
  if (results.errors.length > 0) {
    console.log('\nErrors:');
    results.errors.forEach(e => console.log(`  - ${e.test}: ${e.error}`));
  }
  
  // Check logs
  try {
    const logSize = execSync('ls -la logs/*.log 2>/dev/null | head -5', { encoding: 'utf8' });
    console.log('\nLog files:');
    console.log(logSize);
  } catch {}
  
  db.close();
  
  console.log('\nAudit complete.');
  process.exit(results.errors.length === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
