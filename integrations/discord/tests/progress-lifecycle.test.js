import test from 'node:test';
import assert from 'node:assert/strict';
import { PersistenceStore } from '../src/persistence.js';
import { OrchestratorEventListener } from '../src/event-listener.js';
import {
  redactSensitive,
  formatJobCard,
  formatTaskCard,
  formatAuditReport,
  formatFinalReport
} from '../src/notifications.js';
import { DiscordBridgeApp } from '../src/index.js';

// 11. WebSocket reconnect
test('11. WebSocket reconnect schedules backoff on disconnection', async () => {
  const listener = new OrchestratorEventListener(
    {},
    { getActiveExecutions: () => [] },
    null,
    { wsUrl: 'ws://127.0.0.1:9999/ws', pollIntervalMs: 100000 }
  );

  assert.equal(listener.reconnectDelay, 1000);
  listener.scheduleReconnect();
  assert.ok(listener.reconnectTimer !== null);
  assert.equal(listener.reconnectDelay, 2000);

  listener.stop();
  assert.equal(listener.reconnectTimer, null);
});

// 12. Event deduplication
test('12. Event deduplication drops identical replayed events', () => {
  const listener = new OrchestratorEventListener({}, {}, null, {});

  const evKey = 'task.started:task-123:1';
  assert.equal(listener.isDuplicate(evKey), false);
  // Second time with identical key is duplicate
  assert.equal(listener.isDuplicate(evKey), true);
  // Third time still duplicate
  assert.equal(listener.isDuplicate(evKey), true);

  // Different sequence is not duplicate
  assert.equal(listener.isDuplicate('task.started:task-123:2'), false);
});

// 13. Progress notification formatting
test('13. Progress notification formats job card during execution with active workers and auditors', () => {
  const job = {
    id: 'job-123',
    project_slug: 'ballo',
    status: 'auditing',
    total_requirements: 6,
    verified_requirements: 3
  };

  const agents = {
    byRole: { worker: 2, auditor: 1, integration: 0 }
  };

  const formatted = formatJobCard(job, { projectSlug: 'ballo', agents });

  assert.ok(formatted.includes('CodeOrchestrator'));
  assert.ok(formatted.includes('Job: job-123'));
  assert.ok(formatted.includes('Status: Auditing'));
  assert.ok(formatted.includes('Verified: 3/6'));
  assert.ok(formatted.includes('Workers: 2 active'));
  assert.ok(formatted.includes('Auditors: 1 active'));
  assert.ok(formatted.includes('Integration: Waiting'));
});

// 14. Auditor FAILED reporting & unverified cannot be PASS
test('14. Auditor FAILED reporting accurately reports failures without fabricating PASS', () => {
  const auditRecords = [
    {
      subtask_id: 'sub-456',
      verdict: 'FAILED',
      criteria_json: JSON.stringify([
        { id: 'crit-1', name: 'Must return 200', passed: false, status: 'failed' },
        { id: 'crit-2', name: 'Must write log', passed: true, status: 'passed' }
      ]),
      findings_json: JSON.stringify(['Status code returned was 500']),
      evidence_json: JSON.stringify({ stdout: 'Internal Server Error' }),
      summary: 'Endpoint returned 500 instead of 200'
    }
  ];

  const report = formatAuditReport(auditRecords, 'sub-456');

  assert.ok(report.includes('Auditor Verdict: FAILED'));
  assert.ok(report.includes('Failed Criteria: Must return 200'));
  assert.ok(!report.includes('Auditor Verdict: PASS'));

  // Test that unverified job card NEVER displays PASS
  const unverifiedJob = {
    id: 'job-unverified',
    status: 'completed',
    total_requirements: 5,
    verified_requirements: 2,
    final_audit_verdict: 'FAILED'
  };

  const unverifiedCard = formatJobCard(unverifiedJob);
  assert.ok(!unverifiedCard.includes('Audit: PASS'));
  assert.ok(unverifiedCard.includes('Audit: FAILED'));
});

// 15. Job completion reporting
test('15. Job completion reporting produces accurate summary and PASS only on verified evidence', () => {
  const verifiedJob = {
    id: 'job-999',
    status: 'completed',
    total_requirements: 6,
    verified_requirements: 6,
    final_audit_verdict: 'PASS'
  };

  const card = formatJobCard(verifiedJob);
  assert.ok(card.includes('Status: Completed'));
  assert.ok(card.includes('Requirements: 6/6 verified'));
  assert.ok(card.includes('Audit: PASS'));
  assert.ok(card.includes('Integration: PASS'));
  assert.ok(card.includes('Tests: PASS'));

  const report = formatFinalReport({
    jobId: 'job-999',
    finalVerdict: 'PASS',
    totalRequirements: 6,
    verifiedRequirements: 6
  }, verifiedJob);

  assert.ok(report.content.includes('Audit: PASS'));
});

// 17. Restart persistence
test('17. Restart persistence survives database close and re-open', () => {
  const dbFile = '/tmp/test-persistence-restart-' + Date.now() + '.db';
  let store = new PersistenceStore(dbFile);

  store.saveExecution({
    id: 'job-restart-1',
    kind: 'job',
    guildId: 'g1',
    channelId: 'c1',
    userId: 'u1',
    messageId: 'm1',
    projectId: 'p1',
    projectSlug: 'proj-restart',
    status: 'running'
  });

  store.saveExecution({
    id: 'task-restart-2',
    kind: 'task',
    guildId: 'g1',
    channelId: 'c1',
    userId: 'u1',
    messageId: 'm2',
    projectId: 'p1',
    projectSlug: 'proj-restart',
    status: 'completed'
  });

  store.close();

  // Re-open fresh instance
  store = new PersistenceStore(dbFile);
  const active = store.getActiveExecutions();

  assert.equal(active.length, 1);
  assert.equal(active[0].id, 'job-restart-1');
  assert.equal(active[0].status, 'running');

  const completed = store.getExecution('task-restart-2');
  assert.equal(completed.status, 'completed');

  store.close();
});

// 18. Secret redaction
test('18. Secret redaction redacts tokens, IPs, keys, and deployment home directory paths', () => {
  const ipTailscale = ['100', '64', '0', '10'].join('.');
  const ipPrivate = ['192', '168', '1', '50'].join('.');
  const nrKey = ['NINEROUTER', 'API_KEY'].join('_') + '=' + ['nr', 'live', 'secret123456789'].join('_');
  const skKey = 'sk-' + 'abcdefghijklmnopqrstuvwxyz12345';

  const pkHeader = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  const pkFooter = '-----END ' + 'RSA PRIVATE KEY-----';

  const dtA = ['M', 'T', 'A', '5', 'O', 'T', 'k', '5', 'O', 'T', 'k', '5', 'O', 'T', 'k', '5', 'O', 'T', 'k', '5', 'O', 'T', 'k', '5'].join('');
  const dtB = ['G', 'x', 'y', 'z', 'A', 'b'].join('');
  const dtC = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '1', '2', '3', '4', '5', '6', '7'].join('');
  const syntheticDiscordToken = `${dtA}.${dtB}.${dtC}`;

  const textWithSecrets = [
    `My key is ${nrKey}`,
    `Discord DISCORD_BOT_TOKEN="${syntheticDiscordToken}"`,
    `Connecting to ${ipPrivate} and ${ipTailscale}`,
    'Open /home/someuser/workspaces/app/file.js',
    `Token ${skKey}`,
    `${pkHeader}\nMIIEowIBAAKCAQEA...\n${pkFooter}`
  ].join('\n');

  const cleaned = redactSensitive(textWithSecrets);

  assert.ok(!cleaned.includes('nr_live_secret123456789'));
  assert.ok(!cleaned.includes(syntheticDiscordToken));
  assert.ok(!cleaned.includes(ipPrivate));
  assert.ok(!cleaned.includes(ipTailscale));
  assert.ok(!cleaned.includes('/home/someuser'));
  assert.ok(!cleaned.includes(skKey));
  assert.ok(!cleaned.includes('MIIEowIBAAKCAQEA'));
  assert.ok(cleaned.includes('[REDACTED]'));
});

// 19. Discord message rate limiting & throttling
test('19. Rapid progress events are throttled to progressUpdateIntervalMs', async () => {
  let editsCount = 0;
  const mockChannel = {
    messages: {
      fetch: async () => ({
        edit: async () => { editsCount++; }
      })
    }
  };
  const mockDiscordClient = {
    channels: {
      fetch: async () => mockChannel
    }
  };

  const testDb = new PersistenceStore('/tmp/test-throttle-' + Date.now() + '.db');
  testDb.saveExecution({
    id: 'task-throttle',
    kind: 'task',
    guildId: 'g1',
    channelId: 'c1',
    userId: 'u1',
    messageId: 'm1',
    status: 'running'
  });

  const listener = new OrchestratorEventListener(
    {},
    testDb,
    mockDiscordClient,
    { progressUpdateIntervalMs: 500 }
  );

  // Send 5 rapid progress updates
  for (let i = 1; i <= 5; i++) {
    listener.scheduleDiscordMessageUpdate('task-throttle', 'task', {
      id: 'task-throttle',
      status: 'running',
      step: `Step ${i}`
    });
  }

  // Allow immediate async task tick to complete
  await new Promise(r => setTimeout(r, 25));

  // Exactly 1 execution occurred immediately
  assert.equal(editsCount, 1);

  // Wait for throttle window (500ms) to fire the buffered update
  await new Promise(r => setTimeout(r, 600));

  // Throttled update executed
  assert.ok(editsCount >= 2);
  assert.ok(editsCount < 5); // Did not execute 5 individual edits

  testDb.close();
  listener.stop();
});

// 20. Safe graceful shutdown
test('20. Safe graceful shutdown releases locks and stops services cleanly', async () => {
  const app = new DiscordBridgeApp({
    token: '',
    apiUrl: 'http://127.0.0.1:4000',
    dbPath: '/tmp/test-shutdown-' + Date.now() + '.db'
  });

  app.acquireLock();
  await app.shutdown('SIGTERM');

  // Verify second instance can acquire lock without collision
  const app2 = new DiscordBridgeApp({
    token: '',
    apiUrl: 'http://127.0.0.1:4000',
    dbPath: '/tmp/test-shutdown-2-' + Date.now() + '.db'
  });

  assert.doesNotThrow(() => app2.acquireLock());
  app2.releaseLock();
});
