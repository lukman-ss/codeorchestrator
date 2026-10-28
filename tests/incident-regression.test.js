import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitOperations } from '../src/services/git-operations.js';
import { PersistenceStore } from '../integrations/discord/src/persistence.js';
import {
  parseProjectDirective,
  extractRepositoryDirective,
  checkRepositoryMismatch,
  handleMessage
} from '../integrations/discord/src/natural-chat.js';
import { formatExecutionResultCard, formatTaskCard } from '../integrations/discord/src/notifications.js';
import OrchestratorEventListener from '../integrations/discord/src/event-listener.js';
import {
  recoverRunning,
  startFromQueue,
  getDispatchQueue,
  blockDispatch,
  resumeDispatch,
  cancelTask
} from '../src/services/task-queue.js';
import { init as initDb, close as closeDb, dbRun, dbGet, dbGetOne } from '../src/database/db.js';

test('Incident A: Deterministic project directive parsing and stripping', () => {
  const lineInput = 'project: ballo-starter\nImplement authentication middleware';
  const parsed1 = parseProjectDirective(lineInput);
  assert.equal(parsed1.projectSlug, 'ballo-starter');
  assert.equal(parsed1.cleanedText, 'Implement authentication middleware');

  const prefixInput = 'project: ballo-starter Implement authentication middleware';
  const parsed2 = parseProjectDirective(prefixInput);
  assert.equal(parsed2.projectSlug, 'ballo-starter');
  assert.equal(parsed2.cleanedText, 'Implement authentication middleware');

  const noDirective = 'Implement authentication middleware';
  const parsed3 = parseProjectDirective(noDirective);
  assert.equal(parsed3.projectSlug, null);
  assert.equal(parsed3.cleanedText, 'Implement authentication middleware');
});

test('Incident A: Repository directive extraction and mismatch check', () => {
  const text1 = 'project: ballo-starter\nrepo: https://github.com/lukman-ss/ballo-starter.git\nFix bug';
  const repo1 = extractRepositoryDirective(text1);
  assert.equal(repo1, 'https://github.com/lukman-ss/ballo-starter.git');

  // Starter template cited in description should not be extracted as repository directive
  const textWithStarter = 'project: ballo-todo\nBangun aplikasi web bernama ballo-todo menggunakan Ballo Starter sebagai fondasi:\nhttps://github.com/lukman-ss/ballo-starter';
  assert.equal(extractRepositoryDirective(textWithStarter), null);

  // Standalone repository URL or explicit directive still recognized
  assert.equal(extractRepositoryDirective('https://github.com/lukman-ss/ballo-starter.git'), 'https://github.com/lukman-ss/ballo-starter.git');
  assert.equal(extractRepositoryDirective('git@github.com:lukman-ss/ballo-starter.git'), 'git@github.com:lukman-ss/ballo-starter.git');

  const checkPass = checkRepositoryMismatch(
    'https://github.com/lukman-ss/ballo-starter.git',
    'git@github.com:lukman-ss/ballo-starter.git'
  );
  assert.equal(checkPass.mismatch, false);

  const checkFail = checkRepositoryMismatch(
    'https://github.com/lukman-ss/codeorchestrator',
    'https://github.com/lukman-ss/ballo'
  );
  assert.equal(checkFail.mismatch, true);
});

test('Incident A & Dual Session: Explicit project directive decouples prior session without mutating it', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discord-routing-test-'));
  const dbPath = join(tempDir, 'bridge.db');
  const store = new PersistenceStore(dbPath);

  const guildId = 'guild-1';
  const channelId = 'channel-1';
  const userId = 'user-1';

  // 1. Establish prior active conversation locked to 'ballo'
  const priorConv = store.createConversation({
    id: 'conv-ballo',
    guildId,
    channelId,
    discordUserId: userId,
    sessionId: 'session-ballo-1',
    projectId: 'proj-ballo',
    conversationType: 'project',
    status: 'active'
  });

  const sentMessages = [];
  const clientMock = { user: { id: 'bot-1' } };
  const apiClientMock = {
    async resolveProject(slug) {
      if (slug === 'ballo') return { id: 'proj-ballo', slug: 'ballo', repo_url: 'https://github.com/lukman-ss/ballo' };
      if (slug === 'ballo-starter') return { id: 'proj-ballo-starter', slug: 'ballo-starter', repo_url: 'git@github.com:lukman-ss/ballo-starter.git' };
      return null;
    },
    async createSession({ title, type, projectId, userId }) {
      return { id: `session-${projectId}-created`, title, type, projectId, userId };
    },
    async sendSessionMessage(sessionId, { prompt }) {
      return { response: `Handled for ${sessionId}: ${prompt}` };
    }
  };

  const authMock = {
    isGuildAllowed: () => true,
    isChannelAllowed: () => true,
    hasBotPermissions: () => true,
    isUserAllowed: () => true,
    isSessionAllowedForUser: () => true
  };

  // Case 1: Unknown project requested -> blocked!
  const unknownMsg = {
    id: 'msg-unknown',
    guildId,
    channelId,
    author: { id: userId, bot: false },
    mentions: { users: new Set(['bot-1']), has: (id) => id === 'bot-1' },
    content: '<@bot-1> project: unknown-proj fix stuff',
    async reply(payload) {
      sentMessages.push(payload);
      return { id: 'reply-unknown' };
    }
  };
  await handleMessage(unknownMsg, clientMock, apiClientMock, store, authMock);
  assert.match(sentMessages[0].content, /❌ \*\*Unknown Project\*\*: Project `unknown-proj` not found/);

  // Case 2: Repository mismatch requested -> blocked!
  sentMessages.length = 0;
  const mismatchMsg = {
    id: 'msg-mismatch',
    guildId,
    channelId,
    author: { id: userId, bot: false },
    mentions: { users: new Set(['bot-1']), has: (id) => id === 'bot-1' },
    content: '<@bot-1> project: ballo-starter\nrepo: https://github.com/lukman-ss/codeorchestrator\nfix stuff',
    async reply(payload) {
      sentMessages.push(payload);
      return { id: 'reply-mismatch' };
    }
  };
  await handleMessage(mismatchMsg, clientMock, apiClientMock, store, authMock);
  assert.match(sentMessages[0].content, /❌ \*\*Repository Mismatch\*\*/);

  // Case 3: Valid ballo-starter project directive -> routes to ballo-starter session, prior session intact
  sentMessages.length = 0;
  const validMsg = {
    id: 'msg-starter',
    guildId,
    channelId,
    author: { id: userId, bot: false },
    mentions: { users: new Set(['bot-1']), has: (id) => id === 'bot-1' },
    content: '<@bot-1> project: ballo-starter Implement login endpoint',
    async reply(payload) {
      sentMessages.push(payload);
      return { id: 'reply-starter' };
    }
  };
  await handleMessage(validMsg, clientMock, apiClientMock, store, authMock);
  assert.match(sentMessages[0].content, /Handled for session-proj-ballo-starter-created: Implement login endpoint/);

  // Verify prior conversation is still intact and active
  const checkPrior = store.getConversation(priorConv.id);
  assert.equal(checkPrior.status, 'active');
  assert.equal(checkPrior.project_id, 'proj-ballo');

  // Verify new conversation was created for ballo-starter
  const starterConv = store.getActiveConversation({ guildId, channelId, discordUserId: userId, projectId: 'proj-ballo-starter' });
  assert.ok(starterConv);
  assert.equal(starterConv.project_id, 'proj-ballo-starter');
  assert.equal(starterConv.session_id, 'session-proj-ballo-starter-created');

  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('Incident B: Crash recovery resumes queued tasks and reconciles running tasks', async () => {
  initDb();
  resumeDispatch();

  // Clean test tasks and insert test project
  dbRun("DELETE FROM tasks WHERE id LIKE 'test-task-%'");
  dbRun("DELETE FROM projects WHERE id = 'test-proj-b'");
  dbRun("INSERT INTO projects (id, name, slug, workspace_path) VALUES ('test-proj-b', 'Test Proj B', 'test-proj-b', '/tmp/test-proj-b')");

  // 1. Insert a running task
  dbRun(`
    INSERT INTO tasks (id, project_id, status, execution_status, workflow_status, prompt, pid, created_at, updated_at)
    VALUES ('test-task-running', 'test-proj-b', 'running', 'running', 'running', 'Do work', 99999999, datetime('now'), datetime('now'))
  `);

  // 1b. Insert a task in post-execution workflow (awaiting approval)
  dbRun(`
    INSERT INTO tasks (id, project_id, status, execution_status, workflow_status, prompt, exit_code, created_at, updated_at)
    VALUES ('test-task-awaiting-approval', 'test-proj-b', 'running', 'completed', 'awaiting_approval', 'Awaiting approval task', 0, datetime('now'), datetime('now'))
  `);

  // 2. Insert queued tasks
  dbRun(`
    INSERT INTO tasks (id, project_id, status, execution_status, workflow_status, prompt, created_at, updated_at)
    VALUES ('test-task-queued-1', 'test-proj-b', 'queued', 'queued', 'queued', 'Task 1', datetime('now'), datetime('now'))
  `);
  dbRun(`
    INSERT INTO tasks (id, project_id, status, execution_status, workflow_status, prompt, created_at, updated_at)
    VALUES ('test-task-queued-2', 'test-proj-b', 'queued', 'queued', 'queued', 'Task 2', datetime('now'), datetime('now'))
  `);

  // Call recoverRunning
  recoverRunning();

  const recovered = dbGetOne("SELECT * FROM tasks WHERE id = 'test-task-running'");
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.execution_status, 'interrupted');
  assert.equal(recovered.error, 'server restarted');

  const awaiting = dbGetOne("SELECT * FROM tasks WHERE id = 'test-task-awaiting-approval'");
  assert.equal(awaiting.status, 'running');
  assert.equal(awaiting.execution_status, 'completed');
  assert.equal(awaiting.workflow_status, 'awaiting_approval');

  // Call startFromQueue
  startFromQueue();

  // Tasks from SQLite were loaded into dispatch queue and scheduled
  const task1 = dbGetOne("SELECT * FROM tasks WHERE id = 'test-task-queued-1'");
  assert.ok(['queued', 'running'].includes(task1.status));

  // Clean up running/spawned tasks
  await cancelTask('test-task-queued-1');
  await cancelTask('test-task-queued-2');

  blockDispatch();
  dbRun("DELETE FROM tasks WHERE id LIKE 'test-task-%'");
  dbRun("DELETE FROM projects WHERE id = 'test-proj-b'");
});

test('Incident C: WebSocket event deduplication persists across restarts and throttles terminal notification', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discord-dedup-test-'));
  const dbPath = join(tempDir, 'bridge.db');
  let store = new PersistenceStore(dbPath);

  // Setup execution
  store.saveExecution({
    id: 'exec-dedup-1',
    kind: 'task',
    guildId: 'g1',
    channelId: 'c1',
    userId: 'u1',
    messageId: 'm1',
    status: 'running'
  });

  const edited = [];
  const clientMock = {
    channels: {
      fetch: async () => ({
        messages: {
          fetch: async () => ({
            edit: async (payload) => { edited.push(payload); }
          })
        }
      })
    }
  };

  let listener = new OrchestratorEventListener({}, store, clientMock);

  // 1. Event deduplication
  const ev = {
    type: 'task.progress',
    taskId: 'exec-dedup-1',
    sequence: 1,
    data: { step: 'compiling' }
  };
  const isDup1 = listener.isDuplicate('task.progress:exec-dedup-1:1', 'task.progress', 'exec-dedup-1');
  assert.equal(isDup1, false);

  const isDup2 = listener.isDuplicate('task.progress:exec-dedup-1:1', 'task.progress', 'exec-dedup-1');
  assert.equal(isDup2, true);

  // 2. Restart survival
  store.close();
  store = new PersistenceStore(dbPath);
  listener = new OrchestratorEventListener({}, store, clientMock);

  const isDupAfterRestart = listener.isDuplicate('task.progress:exec-dedup-1:1', 'task.progress', 'exec-dedup-1');
  assert.equal(isDupAfterRestart, true, 'Event must remain duplicate after store restart');

  // 3. Exactly one logical terminal notification per state transition
  await listener.scheduleDiscordMessageUpdate('exec-dedup-1', 'task', { id: 'exec-dedup-1', status: 'completed' });
  assert.equal(edited.length, 1);

  // Repeated terminal updates should be suppressed
  await listener.scheduleDiscordMessageUpdate('exec-dedup-1', 'task', { id: 'exec-dedup-1', status: 'completed' });
  assert.equal(edited.length, 1, 'Redundant terminal update must be suppressed');

  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('Incident D: Status semantics report TASK ACCEPTED - QUEUED for queued acceptance', () => {
  const queuedSubmission = { id: 'sub-queued-1', execution_id: 'task-q-1' };
  const card = formatExecutionResultCard(queuedSubmission, {
    status: 'queued',
    output: 'Task queued with ID: task-q-1'
  });

  assert.match(card.content, /### ⏳ TASK ACCEPTED - QUEUED/);
  assert.doesNotMatch(card.content, /Execution Completed/);
  assert.match(card.content, /\*\*Status\*\*: queued/);
});

test('Submission Idempotency: Atomic claim prevents double-click race condition', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discord-atomic-claim-'));
  const dbPath = join(tempDir, 'bridge.db');
  const store = new PersistenceStore(dbPath);

  store.saveSubmission({
    id: 'sub-race-1',
    guildId: 'g1',
    channelId: 'c1',
    userId: 'u1',
    promptHash: 'abc',
    promptLength: 10,
    status: 'received'
  });

  // First click succeeds
  const firstClaim = store.claimSubmissionForExecution('sub-race-1');
  assert.equal(firstClaim, true);

  // Immediate concurrent second click fails atomically
  const secondClaim = store.claimSubmissionForExecution('sub-race-1');
  assert.equal(secondClaim, false);

  const finalSub = store.getSubmission('sub-race-1');
  assert.equal(finalSub.status, 'executing');

  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('Incident Diagnostic: Task card displays Blocked status and Reason when workflow_status is blocked', () => {
  const taskWithBlockedWorkflow = {
    id: '4aaa52be-21a8-4466-aca9-fd1f7486d7d2',
    project_slug: 'ballo-starter',
    status: 'completed',
    workflow_status: 'blocked',
    error: 'Verification failed: Failed requirements: gofmt, go vet, go test',
    exit_code: 0
  };

  const card = formatTaskCard(taskWithBlockedWorkflow);
  assert.match(card, /Status: Blocked/);
  assert.match(card, /Reason: Verification failed: Failed requirements: gofmt, go vet, go test/);
  assert.doesNotMatch(card, /Status: Completed/);
});

test('GitWorkerEnv: Credential isolation strips SSH_AUTH_SOCK and injects sandbox into PATH', () => {
  const customOverrides = {
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    GIT_SSH: '/usr/bin/ssh',
    GIT_ASKPASS: '/usr/bin/ssh-askpass',
    FOO: 'bar'
  };

  const env = GitOperations.getWorkerEnv(customOverrides);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.GIT_SSH, undefined);
  assert.equal(env.GIT_ASKPASS, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.FOO, 'bar');
  assert.match(env.GIT_SSH_COMMAND, /BatchMode=yes/);
  assert.ok(env.PATH.startsWith(join(process.cwd(), 'bin', 'git-sandbox')));
});

test('GitSandbox: Interceptor script blocks push and send-pack while allowing benign commands', () => {
  const env = GitOperations.getWorkerEnv();

  // 1. git push must fail with exit 1 and security notice
  let pushFailed = false;
  try {
    execSync('git push origin main', { env, stdio: 'pipe' });
  } catch (err) {
    pushFailed = true;
    assert.equal(err.status, 1);
    assert.match(err.stderr.toString(), /blocked in worker sandbox/);
  }
  assert.equal(pushFailed, true, 'Worker sandbox must intercept git push');

  // 2. git send-pack must fail with exit 1
  let sendPackFailed = false;
  try {
    execSync('git send-pack origin main', { env, stdio: 'pipe' });
  } catch (err) {
    sendPackFailed = true;
    assert.equal(err.status, 1);
    assert.match(err.stderr.toString(), /blocked in worker sandbox/);
  }
  assert.equal(sendPackFailed, true, 'Worker sandbox must intercept git send-pack');

  // 3. Benign git commands must execute successfully
  const versionOutput = execSync('git --version', { env, stdio: 'pipe' }).toString().trim();
  assert.match(versionOutput, /git version/);
});
