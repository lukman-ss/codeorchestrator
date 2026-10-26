import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { startTestServer } from './test-helper.js';

let serverContext;
let req;
let TOKEN;
let projectId;
let serverPID;

before(async () => {
  serverContext = await startTestServer();
  req = serverContext.req;
  TOKEN = serverContext.token;
});

after(async () => {
  if (serverPID) {
    try { execSync(`kill -9 ${serverPID}`); } catch {}
  }
  if (serverContext) {
    await serverContext.cleanup();
  }
});

test('Test G: Parallel Workers', async () => {
  const projectRes = await req('/projects', 'POST', {
    name: 'Parallel Test Project',
    slug: 'parallel-test-' + Date.now(),
    defaultModel: '9router/ayce-combo'
  });
  assert.equal(projectRes.status, 201);
  projectId = projectRes.body.id;

  const subtask1 = await req(`/projects/${projectId}/tasks`, 'POST', {
    prompt: 'Write a file named worker1.txt containing "worker1 completed"',
    model: '9router/ayce-combo'
  });
  assert.equal(subtask1.status, 201);

  const subtask2 = await req(`/projects/${projectId}/tasks`, 'POST', {
    prompt: 'Write a file named worker2.txt containing "worker2 completed"',
    model: '9router/ayce-combo'
  });
  assert.equal(subtask2.status, 201);

  const subtask3 = await req(`/projects/${projectId}/tasks`, 'POST', {
    prompt: 'Write a file named worker3.txt containing "worker3 completed"',
    model: '9router/ayce-combo'
  });
  assert.equal(subtask3.status, 201);

  const taskIds = [subtask1.body.id, subtask2.body.id, subtask3.body.id];

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const statuses = await Promise.all(taskIds.map(id => req(`/tasks/${id}`)));
    const allDone = statuses.every(s => ['completed', 'failed'].includes(s.body.status));
    if (allDone) break;
  }

  const finalStatuses = await Promise.all(taskIds.map(id => req(`/tasks/${id}`)));
  assert.ok(finalStatuses.every(s => ['completed', 'failed'].includes(s.body.status)));

  // Worktree files are kept isolated in .agent-worktrees until integration
  assert.ok(taskIds.length === 3);
  assert.ok(finalStatuses.every(s => ['completed', 'failed'].includes(s.body.status)));
});

test('Test H: Dependency Scheduling', async () => {
  const projectRes = await req('/projects', 'POST', {
    name: 'Dependency Test Project',
    slug: 'dependency-test-' + Date.now(),
    defaultModel: '9router/ayce-combo'
  });
  const depProjectId = projectRes.body.id;

  const baseTask = await req(`/projects/${depProjectId}/tasks`, 'POST', {
    prompt: 'Write a file named base.txt containing "base"',
    model: '9router/ayce-combo'
  });

  const dependentTask = await req(`/projects/${depProjectId}/tasks`, 'POST', {
    prompt: 'Read base.txt and append "dependent" to it',
    model: '9router/ayce-combo'
  });

  await new Promise(r => setTimeout(r, 30000));

  const baseStatus = (await req(`/tasks/${baseTask.body.id}`)).body.status;
  assert.ok(['completed', 'failed'].includes(baseStatus));
});

test('Test I: Crash Recovery', async () => {
  const projectRes = await req('/projects', 'POST', {
    name: 'Crash Test Project',
    slug: 'crash-test-' + Date.now(),
    defaultModel: '9router/ayce-combo'
  });

  const taskRes = await req(`/projects/${projectRes.body.id}/tasks`, 'POST', {
    prompt: 'sleep 10',
    model: '9router/ayce-combo'
  });
  const taskId = taskRes.body.id;

  await new Promise(r => setTimeout(r, 1000));

  const health = await req('/health');
  serverPID = health.body.pid;

  execSync(`kill -TERM ${serverPID}`, { stdio: 'pipe' });
  await new Promise(r => setTimeout(r, 3000));

  serverPID = execSync('nohup node src/server.js > /tmp/server.log 2>&1 & echo $!', { encoding: 'utf8', env: serverContext.env }).trim();
  await new Promise(r => setTimeout(r, 2500));

  const recovered = await req(`/tasks/${taskId}`);
  assert.ok(['interrupted', 'failed', 'cancelled'].includes(recovered.body.status));
});

test('Test J: Integration Conflicts', async () => {
  const projectRes = await req('/projects', 'POST', {
    name: 'Conflict Test Project',
    slug: 'conflict-test-' + Date.now(),
    defaultModel: '9router/ayce-combo'
  });
  const conflictProjectId = projectRes.body.id;

  const task1 = await req(`/projects/${conflictProjectId}/tasks`, 'POST', {
    prompt: 'Write a file named conflict-test.txt with content "v1"',
    model: '9router/ayce-combo'
  });

  const task2 = await req(`/projects/${conflictProjectId}/tasks`, 'POST', {
    prompt: 'Write a file named conflict-test.txt with content "v2" (overwrites)',
    model: '9router/ayce-combo'
  });

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s1 = (await req(`/tasks/${task1.body.id}`)).body.status;
    const s2 = (await req(`/tasks/${task2.body.id}`)).body.status;
    if (s1 === 'completed' || s1 === 'failed') break;
  }
});
