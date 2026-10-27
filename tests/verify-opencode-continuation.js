import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
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
    'Accept': 'application/json',
    'Authorization': `Bearer ${TOKEN}`
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
  console.log('--- Step 1: Create standalone session ---');
  const createRes = await req('/sessions', 'POST', {
    title: 'ORBIT-731 Memory Persistence Verification',
    model: '9router/ayce-combo'
  });
  console.log('Create session response:', createRes.status, createRes.body);
  assert.equal(createRes.status, 201);
  const sessionId = createRes.body.id;
  assert.ok(sessionId);

  console.log(`\n--- Step 2: Turn 1 - Teach test verification code ORBIT-731 to session ${sessionId} ---`);
  const turn1Res = await req(`/sessions/${sessionId}/messages`, 'POST', {
    prompt: 'The verification tracking tag for this session is ORBIT-731. Please confirm and state the tracking tag.'
  });
  console.log('Turn 1 response:', turn1Res.status, turn1Res.body);
  assert.equal(turn1Res.status, 200);
  assert.ok(turn1Res.body.response);
  const opencodeSessionId = turn1Res.body.opencodeSessionId;
  console.log(`Captured OpenCode Session ID: ${opencodeSessionId}`);
  assert.ok(opencodeSessionId, 'opencode_session_id must be populated');

  console.log('\n--- Step 3: Restart services via systemctl --user ---');
  execSync('systemctl --user restart coding-orchestrator codeorchestrator-discord');
  console.log('Services restarted. Waiting 3 seconds for health check...');
  await new Promise(r => setTimeout(r, 3000));

  const healthRes = await req('/health');
  console.log('Health check:', healthRes.status, healthRes.body);
  assert.equal(healthRes.status, 200);

  console.log('\n--- Step 4: Verify session survived restart in DB ---');
  const getRes = await req(`/sessions/${sessionId}`);
  console.log('Get session after restart:', getRes.status, getRes.body);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.opencode_session_id, opencodeSessionId);
  assert.equal(getRes.body.status, 'idle'); // Recovered from active/running

  console.log('\n--- Step 5: Turn 2 - Ask for tracking tag from persistent OpenCode session ---');
  const turn2Res = await req(`/sessions/${sessionId}/messages`, 'POST', {
    prompt: 'What was the verification tracking tag specified in our earlier message? Reply with only the tracking tag.'
  });
  console.log('Turn 2 response:', turn2Res.status, turn2Res.body);
  assert.equal(turn2Res.status, 200);
  const reply = turn2Res.body.response || '';
  console.log('Assistant Reply:\n', reply);
  assert.ok(reply.includes('ORBIT-731'), `Response must retain context and contain 'ORBIT-731', got: ${reply}`);

  console.log('\n--- Step 6: Cleanup test session ---');
  const delRes = await req(`/sessions/${sessionId}`, 'DELETE');
  console.log('Deleted test session:', delRes.status);
  assert.equal(delRes.status, 200);

  console.log('\nSUCCESS: Real OpenCode session persistence verified with ORBIT-731 across service restarts!');
}

run().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
