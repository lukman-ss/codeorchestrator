import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

const BASE = 'http://127.0.0.1:4000';
const TOKEN = 'test-token-123';

let childServer = null;

before(async () => {
  try {
    await req('/health');
  } catch {
    childServer = spawn('node', ['src/server.js'], {
      env: { ...process.env, PORT: '4000', HOST: '127.0.0.1', ORCHESTRATOR_API_TOKEN: TOKEN, REQUIRE_AUTH: 'true' },
      stdio: 'ignore'
    });
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const res = await req('/health');
        if (res.status === 200) break;
      } catch {}
    }
  }
});

after(() => {
  if (childServer) {
    try { childServer.kill('SIGTERM'); } catch {}
  }
});

const req = (path, method = 'GET', body = null) => {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
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

test('Job cancellation extension tests', async () => {
  // 1. Create project
  const pRes = await req('/projects', 'POST', {
    name: 'Cancel Test Project',
    slug: 'cancel-test-' + Date.now(),
    defaultModel: '9router/ayce-combo'
  });
  assert.equal(pRes.status, 201);
  const projectId = pRes.body.id;

  // 2. Create job
  const jobRes = await req('/jobs', 'POST', {
    project_id: projectId,
    prompt: '1. First requirement\n2. Second requirement'
  });
  assert.equal(jobRes.status, 201);
  const jobId = jobRes.body.id;
  assert.ok(jobId);

  // 3. GET /jobs lists the job
  const listRes = await req(`/jobs?project_id=${projectId}`);
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.body));
  assert.ok(listRes.body.some(j => j.id === jobId));

  // 4. GET /jobs/:id/report
  const reportRes = await req(`/jobs/${jobId}/report`);
  assert.equal(reportRes.status, 200);
  assert.equal(reportRes.body.jobId, jobId);

  // 5. POST /jobs/:id/cancel
  const cancelRes = await req(`/jobs/${jobId}/cancel`, 'POST', {});
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.status, 'cancelled');

  // Verify status in GET /jobs/:id
  const getRes = await req(`/jobs/${jobId}`);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.status, 'cancelled');

  // 6. Idempotent cancel
  const cancelAgain = await req(`/jobs/${jobId}/cancel`, 'POST', {});
  assert.equal(cancelAgain.status, 200);
  assert.equal(cancelAgain.body.status, 'cancelled');

  // 7. Unknown job returns 404
  const unknownCancel = await req('/jobs/non-existent-uuid/cancel', 'POST', {});
  assert.equal(unknownCancel.status, 404);
});
