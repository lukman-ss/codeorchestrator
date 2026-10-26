import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './test-helper.js';

let serverContext;
let req;

before(async () => {
  serverContext = await startTestServer();
  req = serverContext.req;
});

after(async () => {
  if (serverContext) {
    await serverContext.cleanup();
  }
});

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
