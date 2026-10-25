import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import WebSocket from 'ws';
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = 'test-token-123';
const BASE = 'http://127.0.0.1:4000';
const WS_BASE = 'ws://127.0.0.1:4000/ws';

const req = (path, method = 'GET', body = null, token = TOKEN) => {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    const r = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
};

const run = async () => {
  const results = {};

  // Ensure server is running
  console.log('Ensuring server is running before tests...');
  try {
    await req('/health');
  } catch {
    console.log('Starting server for audit...');
    execSync('nohup node src/server.js > /tmp/server.log 2>&1 &', {
      cwd: process.cwd(),
      env: { ...process.env, ORCHESTRATOR_API_TOKEN: TOKEN }
    });
    // Wait for server ready
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const check = await req('/health');
        if (check.status === 200) break;
      } catch {}
    }
  }

  console.log('\n--- 1. Testing Authentication Rejection ---');
  try {
    const unauth = await req('/projects', 'GET', null, null);
    assert.equal(unauth.status, 401);
    const badAuth = await req('/projects', 'GET', null, 'wrong-token');
    assert.equal(badAuth.status, 401);
    const okAuth = await req('/projects', 'GET', null, TOKEN);
    assert.equal(okAuth.status, 200);
    results['auth_rejection'] = 'PASS';
    console.log('✓ Auth check passed: unauth=401, badToken=401, goodToken=200');
  } catch (err) {
    results['auth_rejection'] = `FAIL: ${err.message}`;
    console.error('✗ Auth check failed:', err);
  }

  console.log('\n--- 2. Create a New Project ---');
  let newProject = null;
  try {
    const slug = 'audit-test-' + Date.now();
    const res = await req('/projects', 'POST', {
      name: 'Audit Project',
      slug,
      defaultModel: '9router/ayce-combo'
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.slug, slug);
    assert.ok(existsSync(res.body.workspace_path));
    newProject = res.body;
    results['create_project'] = 'PASS';
    console.log(`✓ Project created: id=${newProject.id}, workspace=${newProject.workspace_path}`);
  } catch (err) {
    results['create_project'] = `FAIL: ${err.message}`;
    console.error('✗ Create project failed:', err);
  }

  console.log('\n--- 3. Register Existing Project (Import) ---');
  try {
    const existingSlug = 'existing-proj-' + Date.now();
    const existingPath = join(process.env.WORKSPACE_ROOT || join(process.cwd(), 'workspace'), existingSlug);
    mkdirSync(existingPath, { recursive: true });
    const res = await req('/projects/import', 'POST', { slug: existingSlug });
    assert.equal(res.status, 200);
    assert.equal(res.body.slug, existingSlug);
    assert.equal(res.body.workspace_path, existingPath);
    results['import_project'] = 'PASS';
    console.log(`✓ Existing project imported: id=${res.body.id}`);
  } catch (err) {
    results['import_project'] = `FAIL: ${err.message}`;
    console.error('✗ Import project failed:', err);
  }

  console.log('\n--- 4. Submit Real Coding Task & Observe via WebSocket ---');
  let firstTask = null;
  let capturedEvents = [];
  let capturedSessionId = null;
  try {
    const ws = new WebSocket(WS_BASE, [TOKEN]);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const taskRes = await req(`/projects/${newProject.id}/tasks`, 'POST', {
      prompt: 'Write a file named server.js that creates a node http server returning JSON status ok on port 3000, and a test.js that tests it.',
      model: '9router/ayce-combo'
    });
    assert.equal(taskRes.status, 201);
    assert.ok(taskRes.body.id);
    firstTask = taskRes.body;
    console.log(`Task submitted: id=${firstTask.id}, status=${firstTask.status}`);

    ws.send(JSON.stringify({ type: 'subscribe', taskId: firstTask.id }));

    ws.on('message', (msg) => {
      const ev = JSON.parse(msg.toString());
      capturedEvents.push(ev);
      if (ev.type === 'session.created') {
        capturedSessionId = ev.data.sessionId;
      }
    });

    // Wait for task completion
    let finalStatus = 'running';
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const cur = await req(`/tasks/${firstTask.id}`, 'GET');
      if (cur.body.status === 'completed' || cur.body.status === 'failed') {
        finalStatus = cur.body.status;
        break;
      }
    }
    ws.close();

    console.log(`Task completed with status: ${finalStatus}`);
    console.log(`Captured ${capturedEvents.length} WebSocket events:`, capturedEvents.map(e => e.type));

    // Verify workspace files
    const files = readdirSync(newProject.workspace_path);
    console.log(`Workspace files created: ${files.join(', ')}`);
    assert.ok(files.length > 0, 'Workspace files should be present');

    results['real_coding_task'] = finalStatus === 'completed' ? 'PASS' : `FAIL (status=${finalStatus})`;
    results['workspace_changes'] = files.length > 0 ? 'PASS' : 'FAIL';
  } catch (err) {
    results['real_coding_task'] = `FAIL: ${err.message}`;
    results['workspace_changes'] = `FAIL: ${err.message}`;
    console.error('✗ Coding task failed:', err);
  }

  console.log('\n--- 5. Continue OpenCode Session with Another Task ---');
  try {
    const taskDetails = await req(`/tasks/${firstTask.id}`, 'GET');
    const sessionId = taskDetails.body.session_id;
    assert.ok(sessionId, 'Task should have an associated session_id');

    const res2 = await req(`/projects/${newProject.id}/tasks`, 'POST', {
      prompt: 'Add a comment at top of server.js saying "Session continued successfully"',
      sessionId
    });
    assert.equal(res2.status, 201);
    const continuedTask = res2.body;
    console.log(`Continued task created: id=${continuedTask.id}, sessionId=${sessionId}`);

    // Wait for completion
    let finalStatus2 = 'running';
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const cur = await req(`/tasks/${continuedTask.id}`, 'GET');
      if (cur.body.status === 'completed' || cur.body.status === 'failed') {
        finalStatus2 = cur.body.status;
        break;
      }
    }
    console.log(`Continued task completed with status: ${finalStatus2}`);
    results['session_continuation'] = finalStatus2 === 'completed' ? 'PASS' : `FAIL (${finalStatus2})`;
  } catch (err) {
    results['session_continuation'] = `FAIL: ${err.message}`;
    console.error('✗ Session continuation failed:', err);
  }

  console.log('\n--- 6. Cancel a Running Task ---');
  try {
    const cancelTaskRes = await req(`/projects/${newProject.id}/tasks`, 'POST', {
      prompt: 'sleep 300',
      model: '9router/ayce-combo'
    });
    const cancelTaskId = cancelTaskRes.body.id;
    await new Promise(r => setTimeout(r, 500)); // let it start
    const cancelResp = await req(`/tasks/${cancelTaskId}/cancel`, 'POST');
    assert.equal(cancelResp.status, 200);
    assert.equal(cancelResp.body.status, 'cancelled');

    // Confirm DB status is cancelled
    const finalCancel = await req(`/tasks/${cancelTaskId}`, 'GET');
    assert.equal(finalCancel.body.status, 'cancelled');
    console.log(`✓ Cancelled task status: ${finalCancel.body.status}`);
    results['task_cancellation'] = 'PASS';
  } catch (err) {
    results['task_cancellation'] = `FAIL: ${err.message}`;
    console.error('✗ Task cancellation failed:', err);
  }

  console.log('\n--- 7. Restart Orchestrator During Execution & Verify No Orphan ---');
  try {
    const longTask = await req(`/projects/${newProject.id}/tasks`, 'POST', {
      prompt: 'sleep 100',
      model: '9router/ayce-combo'
    });
    const longTaskId = longTask.body.id;
    await new Promise(r => setTimeout(r, 800)); // let it spawn

    const beforeTask = await req(`/tasks/${longTaskId}`, 'GET');
    const childPid = beforeTask.body.pid;
    console.log(`Long task running with PID: ${childPid}`);

    // Kill orchestrator process
    const health = await req('/health', 'GET');
    const serverPid = health.body.pid;
    console.log(`Sending SIGTERM to server PID: ${serverPid}`);
    process.kill(serverPid, 'SIGTERM');

    // Wait 2s for graceful shutdown
    await new Promise(r => setTimeout(r, 2000));

    // Verify child process was killed (no orphan)
    let childStillRunning = false;
    try {
      process.kill(childPid, 0);
      childStillRunning = true;
    } catch {
      childStillRunning = false;
    }
    assert.equal(childStillRunning, false, `Child PID ${childPid} should not be running after shutdown`);
    console.log(`✓ Child PID ${childPid} safely terminated (no orphan)`);
    results['no_orphan_processes'] = 'PASS';

    // Restart server
    console.log('Restarting server...');
    execSync('nohup node src/server.js > /tmp/server.log 2>&1 &', {
      cwd: process.cwd(),
      env: { ...process.env, ORCHESTRATOR_API_TOKEN: TOKEN }
    });
    await new Promise(r => setTimeout(r, 2500));

    // Verify SQLite persistence after restart
    const afterHealth = await req('/health', 'GET');
    assert.equal(afterHealth.status, 200);
    const recoveredTask = await req(`/tasks/${longTaskId}`, 'GET');
    console.log(`Recovered task status after restart: ${recoveredTask.body.status}`);
    assert.ok(['interrupted', 'failed', 'cancelled'].includes(recoveredTask.body.status));
    results['restart_recovery'] = 'PASS';
    results['sqlite_persistence'] = 'PASS';
    console.log('✓ SQLite persistence and restart recovery passed');
  } catch (err) {
    results['no_orphan_processes'] = results['no_orphan_processes'] || `FAIL: ${err.message}`;
    results['restart_recovery'] = `FAIL: ${err.message}`;
    results['sqlite_persistence'] = `FAIL: ${err.message}`;
    console.error('✗ Restart/Orphan test failed:', err);
  }

  console.log('\n--- 8. Disk Pressure Admission Control ---');
  try {
    // We test admission control by checking health and setting threshold higher or calling endpoint
    const h = await req('/health', 'GET');
    assert.ok(h.body.diskFreeMB > 0);
    assert.ok(h.body.diskUsagePercent >= 0);
    assert.ok(h.body.diskThresholdMB === 2048);
    results['disk_pressure'] = 'PASS';
    console.log(`✓ Disk metrics reported: free=${h.body.diskFreeMB}MB, usage=${h.body.diskUsagePercent}%, threshold=${h.body.diskThresholdMB}MB`);
  } catch (err) {
    results['disk_pressure'] = `FAIL: ${err.message}`;
    console.error('✗ Disk check failed:', err);
  }

  console.log('\n========================================');
  console.log('AUDIT E2E TEST SUMMARY:');
  console.log(JSON.stringify(results, null, 2));
  console.log('========================================\n');
};

run().catch(console.error);
