import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { startTestServer } from './test-helper.js';

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

function fetch(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` };
    const req = http.request(url, { ...opts, headers }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function wsMessage(ws, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, timeout);
    ws.once('message', (msg) => { clearTimeout(timer); resolve(JSON.parse(msg.toString())); });
  });
}

test('GET /health returns ok', async () => {
  const r = await fetch('/health');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.status, 'ok');
});

test('POST /projects creates project', async () => {
  const slug = 'smoke-test-' + Date.now();
  const r = await fetch('/projects', { method: 'POST', body: JSON.stringify({ name: 'Smoke Test', slug, defaultModel: '9router/ayce-combo' }) });
  assert.equal(r.status, 201);
  const j = JSON.parse(r.body);
  assert.ok(j.id);
  assert.equal(j.slug, slug);
  global.projectId = j.id;
  global.slug = slug;
});

test('GET /projects lists project', async () => {
  const r = await fetch('/projects');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(Array.isArray(j));
  assert.ok(j.find(p => p.slug === global.slug));
});

test('POST /projects/:id/tasks creates task', async () => {
  const r = await fetch(`/projects/${global.projectId}/tasks`, { method: 'POST', body: JSON.stringify({ prompt: 'print "hello"', model: '9router/ayce-combo' }) });
  assert.equal(r.status, 201);
  const j = JSON.parse(r.body);
  assert.ok(j.id);
  global.taskId = j.id;
});

test('WebSocket streams events', async () => {
  const ws = new WebSocket(`${BASE.replace('http','ws')}/ws`, [TOKEN]);
  await new Promise(r => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'subscribe', taskId: global.taskId }));
  const ev = await wsMessage(ws, 30000);
  assert.ok(['task.started', 'task.queued', 'task.progress'].includes(ev.type));
  ws.close();
});

test('Task reaches terminal state', async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await fetch(`/tasks/${global.taskId}`);
    const j = JSON.parse(r.body);
    if (j.status === 'completed' || j.status === 'failed') { assert.ok(true); return; }
  }
  throw new Error('task not terminal');
});
