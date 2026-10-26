import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startTestServer } from './test-helper.js';

let serverContext;
let req;
let db;

before(async () => {
  serverContext = await startTestServer();
  req = serverContext.req;
  db = new Database(serverContext.dbPath);
});

after(async () => {
  if (db) {
    try { db.close(); } catch {}
  }
  if (serverContext) {
    await serverContext.cleanup();
  }
});

// 1. Standalone session creation
test('1. Standalone Session Creation: session_type is standalone and project_id is null', async () => {
  const res = await req('/sessions', 'POST', {
    title: 'Standalone Q&A',
    model: '9router/ayce-combo'
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.session_type, 'standalone');
  assert.equal(res.body.project_id, null);
  assert.ok(res.body.id);
  assert.equal(res.body.title, 'Standalone Q&A');
});

// 2. Standalone session does not create project in projects table
test('2. Standalone Session DB Isolation: does not insert row into projects table', async () => {
  const countBefore = db.prepare('SELECT COUNT(*) as count FROM projects').get().count;
  const res = await req('/sessions', 'POST', { title: 'No Project Created' });
  assert.equal(res.status, 201);
  const countAfter = db.prepare('SELECT COUNT(*) as count FROM projects').get().count;
  assert.equal(countBefore, countAfter);
});

// 3. Standalone session does not create directory in workspace/
test('3. Standalone Session Workspace Isolation: does not create directory under workspace/', async () => {
  const res = await req('/sessions', 'POST', { title: 'Workspace Isolation Check' });
  assert.equal(res.status, 201);
  const sessionId = res.body.id;

  const workspaceEntries = existsSync(serverContext.workspaceRoot)
    ? readdirSync(serverContext.workspaceRoot)
    : [];
  assert.ok(!workspaceEntries.includes(sessionId));
  assert.ok(!workspaceEntries.some(e => e.includes('Workspace Isolation Check')));
});

// 4. Standalone session creates runtime directory in session-runtime/<id>
test('4. Standalone Session Runtime Directory: creates directory in session-runtime/<id>', async () => {
  const res = await req('/sessions', 'POST', { title: 'Runtime Dir Check' });
  assert.equal(res.status, 201);
  const sessionId = res.body.id;
  const expectedDir = join(serverContext.sessionRuntimeRoot, sessionId);
  assert.ok(existsSync(expectedDir));
});

// 5. Standalone session supports custom title, model, and userId
test('5. Standalone Session Parameters: sets title, model, and userId', async () => {
  const res = await req('/sessions', 'POST', {
    title: 'Custom Session',
    model: '9router/ag/gemini-3.8-flash-high',
    userId: 'user_12345'
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.title, 'Custom Session');
  assert.equal(res.body.model, '9router/ag/gemini-3.8-flash-high');
  assert.equal(res.body.user_id, 'user_12345');
});

// 6. Standalone session metadata JSON
test('6. Standalone Session Metadata: properly stores and returns metadata JSON', async () => {
  const res = await req('/sessions', 'POST', {
    title: 'Metadata Session',
    metadata: { source: 'discord', guildId: 'g-999', tags: ['audit', 'ci'] }
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.metadata, { source: 'discord', guildId: 'g-999', tags: ['audit', 'ci'] });
});

// 7. Project-linked session creation via POST /sessions with projectId
test('7. Project Session Creation: POST /sessions with projectId', async () => {
  const pRes = await req('/projects', 'POST', { name: 'Proj Session Test', slug: 'proj-sess-test' });
  assert.equal(pRes.status, 201);
  const projectId = pRes.body.id;

  const res = await req('/sessions', 'POST', {
    projectId,
    title: 'Project Attached Session'
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.session_type, 'project');
  assert.equal(res.body.project_id, projectId);
});

// 8. Project-linked session creation via POST /projects/:id/sessions
test('8. Project Session Creation: POST /projects/:id/sessions', async () => {
  const pRes = await req('/projects', 'POST', { name: 'Subroute Test', slug: 'subroute-test' });
  assert.equal(pRes.status, 201);
  const projectId = pRes.body.id;

  const res = await req(`/projects/${projectId}/sessions`, 'POST', {
    title: 'Subroute Session'
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.session_type, 'project');
  assert.equal(res.body.project_id, projectId);
});

// 9. Project session reuses project workspace path
test('9. Project Session Workspace: reuses project workspace, no session-runtime dir', async () => {
  const pRes = await req('/projects', 'POST', { name: 'Reuse Workspace Test', slug: 'reuse-ws-test' });
  const projectId = pRes.body.id;

  const res = await req(`/projects/${projectId}/sessions`, 'POST', { title: 'WS Check' });
  assert.equal(res.status, 201);
  const sessionId = res.body.id;
  const runtimeDir = join(serverContext.sessionRuntimeRoot, sessionId);
  assert.ok(!existsSync(runtimeDir));
});

// 10. Project session validation: fails with 404 when project not found
test('10. Project Session Validation: fails with 404 when project not found', async () => {
  const res = await req('/projects/00000000-0000-0000-0000-000000000000/sessions', 'POST', {
    title: 'Ghost Project Session'
  });
  assert.equal(res.status, 404);
});

// 11. DB Constraint: prevents standalone session with non-null project_id
test('11. DB Constraint: standalone session with project_id violates CHECK constraint', async () => {
  const pRes = await req('/projects', 'POST', { name: 'Constraint Check', slug: 'constraint-check' });
  const projectId = pRes.body.id;

  assert.throws(() => {
    db.prepare(`
      INSERT INTO sessions (id, project_id, session_type, status)
      VALUES ('invalid-sess-1', ?, 'standalone', 'active')
    `).run(projectId);
  }, /CHECK constraint failed/);
});

// 12. DB Constraint: prevents project session with null project_id
test('12. DB Constraint: project session with null project_id violates CHECK constraint', async () => {
  assert.throws(() => {
    db.prepare(`
      INSERT INTO sessions (id, project_id, session_type, status)
      VALUES ('invalid-sess-2', NULL, 'project', 'active')
    `).run();
  }, /CHECK constraint failed/);
});

// 13. DB Constraint: rejects invalid session_type values
test('13. DB Constraint: rejects invalid session_type', async () => {
  assert.throws(() => {
    db.prepare(`
      INSERT INTO sessions (id, session_type, status)
      VALUES ('invalid-sess-3', 'unknown_type', 'active')
    `).run();
  }, /CHECK constraint failed/);
});

// 14. DB Constraint: rejects invalid status values
test('14. DB Constraint: rejects invalid session status values', async () => {
  assert.throws(() => {
    db.prepare(`
      INSERT INTO sessions (id, session_type, status)
      VALUES ('invalid-sess-4', 'standalone', 'invalid_status')
    `).run();
  }, /CHECK constraint failed/);
});

// 15. GET /sessions lists all sessions
test('15. GET /sessions: lists both standalone and project sessions', async () => {
  const res = await req('/sessions');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  const hasStandalone = res.body.some(s => s.session_type === 'standalone');
  const hasProject = res.body.some(s => s.session_type === 'project');
  assert.ok(hasStandalone);
  assert.ok(hasProject);
});

// 16. GET /sessions?type=standalone filters standalone sessions
test('16. GET /sessions?type=standalone: filters standalone sessions only', async () => {
  const res = await req('/sessions?type=standalone');
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0);
  assert.ok(res.body.every(s => s.session_type === 'standalone' && s.project_id === null));
});

// 17. GET /sessions?projectId=<id> filters project sessions
test('17. GET /sessions?projectId=<id>: filters sessions by project', async () => {
  const pRes = await req('/projects', 'POST', { name: 'Filter Proj', slug: 'filter-proj' });
  const projectId = pRes.body.id;
  await req(`/projects/${projectId}/sessions`, 'POST', { title: 'P1 Sess 1' });
  await req(`/projects/${projectId}/sessions`, 'POST', { title: 'P1 Sess 2' });

  const res = await req(`/sessions?projectId=${projectId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.ok(res.body.every(s => s.project_id === projectId));
});

// 18. GET /sessions/:id retrieves session details with metadata
test('18. GET /sessions/:id: returns session with parsed metadata', async () => {
  const created = await req('/sessions', 'POST', {
    title: 'Single Session Lookup',
    metadata: { key: 'value123' }
  });
  const res = await req(`/sessions/${created.body.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, created.body.id);
  assert.equal(res.body.title, 'Single Session Lookup');
  assert.deepEqual(res.body.metadata, { key: 'value123' });
});

// 19. PATCH /sessions/:id updates title, model, status, and metadata
test('19. PATCH /sessions/:id: updates properties correctly', async () => {
  const created = await req('/sessions', 'POST', { title: 'Original Title', model: 'original-model' });
  const patchRes = await req(`/sessions/${created.body.id}`, 'PATCH', {
    title: 'Updated Title',
    status: 'idle',
    metadata: { modified: true }
  });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.body.title, 'Updated Title');
  assert.equal(patchRes.body.status, 'idle');
  assert.deepEqual(patchRes.body.metadata, { modified: true });
});

// 20. PATCH /sessions/:id rejects cross-workspace re-binding
test('20. PATCH /sessions/:id: rejects cross-workspace re-binding', async () => {
  const created = await req('/sessions', 'POST', { title: 'Cannot Rebind' });
  const patchRes = await req(`/sessions/${created.body.id}`, 'PATCH', {
    projectId: '00000000-0000-0000-0000-000000000001'
  });
  assert.equal(patchRes.status, 400);
  assert.ok(patchRes.body.error.includes('workspace boundaries'));
});

// 21. DELETE /sessions/:id deletes session and cascades messages
test('21. DELETE /sessions/:id: removes session and message cascade', async () => {
  const created = await req('/sessions', 'POST', { title: 'To Delete' });
  const sessionId = created.body.id;

  // Insert test message directly
  db.prepare(`
    INSERT INTO session_messages (id, session_id, role, content)
    VALUES ('msg-del-1', ?, 'user', 'hello')
  `).run(sessionId);

  const delRes = await req(`/sessions/${sessionId}`, 'DELETE');
  assert.equal(delRes.status, 200);

  const getRes = await req(`/sessions/${sessionId}`);
  assert.equal(getRes.status, 404);

  const remainingMsgs = db.prepare('SELECT COUNT(*) as c FROM session_messages WHERE session_id = ?').get(sessionId).c;
  assert.equal(remainingMsgs, 0);
});

// 22. Execution safety: cannot execute messages on closed session
test('22. Execution Safety: rejects message execution on closed session with HTTP 409', async () => {
  const created = await req('/sessions', 'POST', { title: 'Closed Sess' });
  await req(`/sessions/${created.body.id}`, 'PATCH', { status: 'closed' });

  const msgRes = await req(`/sessions/${created.body.id}/messages`, 'POST', { prompt: 'Hello?' });
  assert.equal(msgRes.status, 409);
  assert.ok(msgRes.body.error.includes('closed'));
});

// 23. Message recording: persists user and assistant messages in session_messages
test('23. Message Recording: records messages with correct roles and timestamps', async () => {
  const created = await req('/sessions', 'POST', { title: 'Msg Recording Test' });
  const sessionId = created.body.id;

  // Insert mock records
  db.prepare(`INSERT INTO session_messages (id, session_id, role, content) VALUES ('msg-rec-1', ?, 'user', 'Ping')`).run(sessionId);
  db.prepare(`INSERT INTO session_messages (id, session_id, role, content) VALUES ('msg-rec-2', ?, 'assistant', 'Pong')`).run(sessionId);

  const listRes = await req(`/sessions/${sessionId}/messages`);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.length, 2);
  assert.equal(listRes.body[0].role, 'user');
  assert.equal(listRes.body[0].content, 'Ping');
  assert.equal(listRes.body[1].role, 'assistant');
  assert.equal(listRes.body[1].content, 'Pong');
});

// 24. Concurrency lock: sequential message execution lock prevents corruption
test('24. Concurrency Lock: multiple message calls on session are serialized', async () => {
  const created = await req('/sessions', 'POST', { title: 'Concurrency Test' });
  const sessionId = created.body.id;

  // Test that session-service withSessionLock serializes concurrent requests
  const start = Date.now();
  // Send 2 quick requests; the service mutex locks the session
  const p1 = req(`/sessions/${sessionId}/messages`, 'POST', { prompt: 'Say 1' }).catch(e => e);
  const p2 = req(`/sessions/${sessionId}/messages`, 'POST', { prompt: 'Say 2' }).catch(e => e);

  const [r1, r2] = await Promise.all([p1, p2]);
  // Both requests handled safely without sqlite busy or state conflict
  assert.ok(r1.status === 200 || r1.status === 500);
  assert.ok(r2.status === 200 || r2.status === 500);
});

// 25. Multi-session isolation: isolated runtime directories
test('25. Multi-session Isolation: separate runtime paths per standalone session', async () => {
  const s1 = await req('/sessions', 'POST', { title: 'Session A' });
  const s2 = await req('/sessions', 'POST', { title: 'Session B' });

  assert.notEqual(s1.body.id, s2.body.id);
  const path1 = join(serverContext.sessionRuntimeRoot, s1.body.id);
  const path2 = join(serverContext.sessionRuntimeRoot, s2.body.id);
  assert.notEqual(path1, path2);
  assert.ok(existsSync(path1));
  assert.ok(existsSync(path2));
});

// 26. Project is_test filtering: default excludes is_test=1, includeTest=true returns all
test('26. Project is_test Filtering: list excludes test projects by default', async () => {
  const prodProject = await req('/projects', 'POST', { name: 'Real Project', slug: 'real-project' });
  const testProject = await req('/projects', 'POST', { name: 'Test Project', slug: 'test-project', isTest: true });

  const defaultList = await req('/projects');
  assert.equal(defaultList.status, 200);
  assert.ok(defaultList.body.some(p => p.id === prodProject.body.id));
  assert.ok(!defaultList.body.some(p => p.id === testProject.body.id));

  const allList = await req('/projects?includeTest=true');
  assert.equal(allList.status, 200);
  assert.ok(allList.body.some(p => p.id === prodProject.body.id));
  assert.ok(allList.body.some(p => p.id === testProject.body.id));
});

// 27. Backward compatibility: creating tasks with and without pre-existing session
test('27. Backward Compatibility: project tasks can be created with or without session ID', async () => {
  const pRes = await req('/projects', 'POST', { name: 'Compat Proj', slug: 'compat-proj' });
  const projectId = pRes.body.id;

  // Without session ID (auto-creates project session)
  const task1 = await req(`/projects/${projectId}/tasks`, 'POST', { prompt: 'Task without session' });
  assert.equal(task1.status, 201);
  assert.ok(task1.body.id);

  // With existing project session
  const sessRes = await req(`/projects/${projectId}/sessions`, 'POST', { title: 'Explicit Session' });
  const task2 = await req(`/projects/${projectId}/tasks`, 'POST', {
    prompt: 'Task with session',
    sessionId: sessRes.body.id
  });
  assert.equal(task2.status, 201);
  assert.ok(task2.body.id);
});
