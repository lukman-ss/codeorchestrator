import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4000';

function loadToken() {
  if (process.env.ORCHESTRATOR_API_TOKEN) {
    return process.env.ORCHESTRATOR_API_TOKEN;
  }
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf8');
    const match = content.match(/^ORCHESTRATOR_API_TOKEN=(.+)$/m);
    if (match) {
      return match[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

const TOKEN = loadToken();

async function req(path, method = 'GET', body = undefined) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${TOKEN}`
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, body: data };
}

async function run() {
  console.log('=== Step 1: Ballo Workspace Safety Guard Acceptance Test ===');
  const balloPath = process.env.WORKSPACE_ROOT
    ? resolve(process.env.WORKSPACE_ROOT, 'ballo')
    : resolve(process.env.HOME || '', 'workspace/ballo');
  let initialBalloRemote = null;
  if (existsSync(balloPath)) {
    try {
      initialBalloRemote = execSync('git config --get remote.origin.url', {
        cwd: balloPath,
        encoding: 'utf8'
      }).trim();
    } catch {}
  }

  // 1. Validation endpoint reports mismatch
  const valRes = await req('/projects/a78db8a9-3134-4f5f-9719-ecd2fe16c9ec/validate');
  console.log('Ballo validate status:', valRes.status, valRes.body);
  assert.equal(valRes.status, 200);
  assert.equal(valRes.body.valid, false);
  assert.equal(valRes.body.mismatch, true);
  assert.match(valRes.body.error, /Repository mismatch detected/);

  // 2. Task creation rejected
  const taskRes = await req('/projects/a78db8a9-3134-4f5f-9719-ecd2fe16c9ec/tasks', 'POST', {
    prompt: 'Implement Ballo feature'
  });
  console.log('Ballo task rejection status:', taskRes.status);
  assert.notEqual(taskRes.status, 201);
  assert.match(taskRes.body?.error || '', /Repository mismatch/);

  // 3. Multi-agent job rejected
  const jobRes = await req('/jobs', 'POST', {
    project_id: 'a78db8a9-3134-4f5f-9719-ecd2fe16c9ec',
    prompt: 'Implement Ballo multi-agent job'
  });
  console.log('Ballo job rejection status:', jobRes.status);
  assert.notEqual(jobRes.status, 201);
  assert.match(jobRes.body?.error || '', /Repository mismatch/);

  // 4. Project session creation rejected
  const sessRejectRes = await req('/sessions', 'POST', {
    projectId: 'a78db8a9-3134-4f5f-9719-ecd2fe16c9ec',
    title: 'Ballo Session'
  });
  console.log('Ballo session rejection status:', sessRejectRes.status);
  assert.notEqual(sessRejectRes.status, 201);
  assert.match(sessRejectRes.body?.error || '', /Repository mismatch/);

  // 5. Verify Ballo workspace was NOT mutated or deleted
  if (existsSync(balloPath)) {
    const afterRemote = execSync('git config --get remote.origin.url', {
      cwd: balloPath,
      encoding: 'utf8'
    }).trim();
    assert.equal(afterRemote, initialBalloRemote, 'Ballo remote origin must remain untouched');
  }
  console.log('✓ Ballo workspace safety checks passed.');

  console.log('\n=== Step 2: Real OpenCode Continuation on Disposable Project ===');
  const projName = `disposable-spec-${Date.now()}`;
  const projRes = await req('/projects', 'POST', {
    name: projName,
    initGit: true,
    isTest: 1
  });
  console.log('Project creation response:', projRes.status, projRes.body?.slug);
  assert.equal(projRes.status, 201);
  const projectId = projRes.body.id;
  const workspacePath = projRes.body.workspace_path;

  let sessionId = null;
  try {
    // Create project session
    const sessRes = await req(`/projects/${projectId}/sessions`, 'POST', {
      title: 'Disposable Specification Session'
    });
    console.log('Session creation response:', sessRes.status, sessRes.body?.id);
    assert.equal(sessRes.status, 201);
    sessionId = sessRes.body.id;

    // Turn 1: Specification injection with concrete requirement tag
    const specPrompt = `
# System Specification Turn 1
Tracking requirement identifier: SPEC-ACCEPTANCE-7799
Target status code: 429
Action: Acknowledge the requirement identifier and status code verbatim.
`.trim();

    console.log('Sending Turn 1 prompt...');
    const turn1Res = await req(`/sessions/${sessionId}/messages`, 'POST', {
      prompt: specPrompt
    });
    console.log('Turn 1 response status:', turn1Res.status);
    assert.equal(turn1Res.status, 200);
    assert.ok(turn1Res.body.response, 'Turn 1 must return response');
    const opencodeSessionId = turn1Res.body.opencodeSessionId;
    console.log(`Captured OpenCode Session ID: ${opencodeSessionId}`);
    assert.ok(opencodeSessionId, 'OpenCode session ID must be present');

    // Turn 2: Continuation referencing Turn 1 specification
    console.log('Sending Turn 2 continuation prompt...');
    const turn2Res = await req(`/sessions/${sessionId}/messages`, 'POST', {
      prompt: 'What was the tracking requirement identifier and target status code specified in turn 1? Reply concisely.'
    });
    console.log('Turn 2 response status:', turn2Res.status);
    assert.equal(turn2Res.status, 200);
    const reply2 = turn2Res.body.response || '';
    console.log('Turn 2 assistant reply:', reply2);
    assert.ok(
      reply2.includes('SPEC-ACCEPTANCE-7799'),
      `Turn 2 must preserve requirement identifier SPEC-ACCEPTANCE-7799, got: ${reply2}`
    );
    assert.ok(
      reply2.includes('429'),
      `Turn 2 must preserve target status code 429, got: ${reply2}`
    );
    console.log('✓ Real OpenCode continuation verified with full context retention.');
  } finally {
    // Cleanup
    if (sessionId) {
      await req(`/sessions/${sessionId}`, 'DELETE').catch(() => {});
    }
    if (workspacePath && existsSync(workspacePath)) {
      try { rmSync(workspacePath, { recursive: true, force: true }); } catch {}
    }
    console.log('✓ Cleanup completed.');
  }

  console.log('\nSUCCESS: Real acceptance test passed.');
}

run().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
