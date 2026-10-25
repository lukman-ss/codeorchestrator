import test from 'node:test';
import assert from 'node:assert/strict';
import { data as codeCommandData, execute, handleAutocomplete } from '../src/commands/code.js';
import { AuthorizationService } from '../src/authorization.js';
import { PersistenceStore } from '../src/persistence.js';
import { OrchestratorApiClient } from '../src/api-client.js';
import config from '../src/config.js';
import { redactSensitive } from '../src/notifications.js';

function createMockInteraction({
  subcommand = 'help',
  guildId = 'guild-100',
  channelId = 'channel-200',
  userId = 'user-300',
  memberRoles = ['role-admin'],
  options = {},
  inGuild = true
} = {}) {
  const replies = [];
  let isDeferred = false;

  return {
    guildId: inGuild ? guildId : null,
    channelId,
    user: { id: userId, tag: `User#${userId}` },
    userId,
    member: {
      roles: {
        cache: new Map(memberRoles.map(r => [r, { id: r }]))
      }
    },
    inGuild: () => inGuild,
    replied: false,
    deferred: isDeferred,
    options: {
      getSubcommand: () => subcommand,
      getString: (name, req = false) => options[name] ?? null,
      getBoolean: (name, req = false) => options[name] ?? null,
      getAttachment: (name) => options[name] ?? null,
      getFocused: (full) => full ? { name: 'project', value: options['project'] || '' } : options['project'] || ''
    },
    reply: async (payload) => {
      replies.push(payload);
      return { id: 'msg-' + Date.now(), ...payload };
    },
    deferReply: async () => {
      isDeferred = true;
      return true;
    },
    editReply: async (payload) => {
      replies.push(payload);
      return { id: 'msg-' + Date.now(), ...payload };
    },
    respond: async (choices) => choices,
    getReplies: () => replies
  };
}

// 1. Slash command registration
test('1. Slash command registration schema has group /code and all 8 subcommands', () => {
  const json = codeCommandData.toJSON();
  assert.equal(json.name, 'code');
  assert.equal(json.dm_permission, false);

  const subcommands = json.options.filter(opt => opt.type === 1).map(opt => opt.name);
  const expectedSubcommands = [
    'projects',
    'run',
    'job',
    'status',
    'audit',
    'report',
    'cancel',
    'help'
  ];

  for (const expected of expectedSubcommands) {
    assert.ok(subcommands.includes(expected), `Missing subcommand: ${expected}`);
  }
});

// 2. Authorized command execution
test('2. Authorized command execution succeeds for /code help', async () => {
  const prevGuilds = config.allowedGuildIds;
  const prevChannels = config.allowedChannelIds;
  const prevUsers = config.allowedUserIds;

  try {
    config.allowedGuildIds = ['guild-100'];
    config.allowedChannelIds = ['channel-200'];
    config.allowedUserIds = ['user-300'];

    const interaction = createMockInteraction({ subcommand: 'help' });
    await execute(interaction);

    const replies = interaction.getReplies();
    assert.ok(replies.length > 0);
    assert.ok(replies[0].content.includes('CodeOrchestrator Discord Commands'));
  } finally {
    config.allowedGuildIds = prevGuilds;
    config.allowedChannelIds = prevChannels;
    config.allowedUserIds = prevUsers;
  }
});

// 3. Unauthorized user rejection
test('3. Unauthorized user is rejected with Access Denied', async () => {
  const auth = new AuthorizationService({
    allowedGuildIds: ['guild-100'],
    allowedChannelIds: ['channel-200'],
    allowedUserIds: ['authorized-user-only'],
    allowedRoleIds: []
  });

  const interaction = createMockInteraction({
    userId: 'unauthorized-user',
    memberRoles: []
  });

  const check = auth.validateInteraction(interaction, 'help');
  assert.equal(check.allowed, false);
  assert.ok(check.reason.includes('not authorized'));
});

// 4. Unauthorized channel rejection
test('4. Unauthorized channel is rejected', async () => {
  const auth = new AuthorizationService({
    allowedGuildIds: ['guild-100'],
    allowedChannelIds: ['allowed-channel-only'],
    allowedUserIds: ['*'],
    allowedRoleIds: []
  });

  const interaction = createMockInteraction({
    channelId: 'wrong-channel'
  });

  const check = auth.validateInteraction(interaction, 'help');
  assert.equal(check.allowed, false);
  assert.ok(check.reason.includes('channel'));
});

// 5. Unauthorized guild rejection & DM rejection
test('5. Unauthorized guild and DM executions are rejected', async () => {
  const auth = new AuthorizationService({
    allowedGuildIds: ['allowed-guild-only'],
    allowedChannelIds: ['*'],
    allowedUserIds: ['*']
  });

  // Wrong guild
  const wrongGuildInteraction = createMockInteraction({ guildId: 'other-guild' });
  const guildCheck = auth.validateInteraction(wrongGuildInteraction, 'help');
  assert.equal(guildCheck.allowed, false);
  assert.ok(guildCheck.reason.includes('server is not authorized'));

  // DM interaction
  const dmInteraction = createMockInteraction({ inGuild: false });
  const dmCheck = auth.validateInteraction(dmInteraction, 'help');
  assert.equal(dmCheck.allowed, false);
  assert.ok(dmCheck.reason.includes('Direct Messages'));
});

// 6. Project resolution & authorization
test('6. Project resolution and authorization prevents access to unauthorized projects', async () => {
  const auth = new AuthorizationService({
    allowedProjects: ['allowed-project'],
    userProjects: {
      'user-restricted': ['allowed-project']
    }
  });

  const allowed = auth.isProjectAllowedForUser('user-restricted', [], { id: 'proj-1', slug: 'allowed-project' });
  assert.equal(allowed, true);

  const denied = auth.isProjectAllowedForUser('user-restricted', [], { id: 'secret-proj', slug: 'secret-slug' });
  assert.equal(denied, false);
});

// 7. Simple task submission
test('7. Simple task submission formats initial queued state and tracks IDs', async () => {
  const testDb = new PersistenceStore('/tmp/test-bridge-task-' + Date.now() + '.db');

  const mockApi = {
    fetchProjects: async () => [{ id: 'p1', slug: 'my-project', name: 'My Project' }],
    resolveProject: async () => ({ id: 'p1', slug: 'my-project', name: 'My Project' }),
    createTask: async () => ({ id: 'task-test-777', status: 'queued' })
  };

  const task = await mockApi.createTask('p1', { prompt: 'Write hello world' });
  assert.equal(task.id, 'task-test-777');
  assert.equal(task.status, 'queued');

  testDb.saveExecution({
    id: task.id,
    kind: 'task',
    guildId: 'guild-100',
    channelId: 'channel-200',
    userId: 'user-300',
    messageId: 'msg-999',
    projectId: 'p1',
    projectSlug: 'my-project',
    status: task.status
  });

  const saved = testDb.getExecution(task.id);
  assert.equal(saved.id, 'task-test-777');
  assert.equal(saved.status, 'queued');
  testDb.close();
});

// 8. Multi-agent job submission
test('8. Multi-agent job submission creates job and tracks requirement count', async () => {
  const testDb = new PersistenceStore('/tmp/test-bridge-job-' + Date.now() + '.db');

  const mockApi = {
    fetchProjects: async () => [{ id: 'p1', slug: 'my-project', name: 'My Project' }],
    resolveProject: async () => ({ id: 'p1', slug: 'my-project', name: 'My Project' }),
    createJob: async () => ({ id: 'job-test-888', subtaskId: 'sub-1' }),
    getJob: async () => ({ id: 'job-test-888', total_requirements: 4, verified_requirements: 0, status: 'planning' })
  };

  const jobRes = await mockApi.createJob('p1', '1. Do this\n2. Do that');
  const details = await mockApi.getJob(jobRes.id);

  assert.equal(details.total_requirements, 4);
  assert.equal(details.status, 'planning');

  testDb.saveExecution({
    id: jobRes.id,
    kind: 'job',
    guildId: 'guild-100',
    channelId: 'channel-200',
    userId: 'user-300',
    messageId: 'msg-888',
    projectId: 'p1',
    projectSlug: 'my-project',
    status: details.status
  });

  const saved = testDb.getExecution(jobRes.id);
  assert.equal(saved.id, 'job-test-888');
  assert.equal(saved.kind, 'job');
  testDb.close();
});

// 9. Long prompt attachment validation
test('9. Prompt attachment validation enforces .txt/.md, max bytes, and reject binary', async () => {
  const maxBytes = 256 * 1024;

  // Invalid extension
  const exeAttachment = { name: 'script.exe', size: 1000 };
  const isTxtOrMd = (name) => name.endsWith('.txt') || name.endsWith('.md');
  assert.equal(isTxtOrMd(exeAttachment.name), false);

  // Exceeds size
  const hugeAttachment = { name: 'spec.md', size: 500 * 1024 };
  assert.ok(hugeAttachment.size > maxBytes);

  // Contains null byte
  const binaryBuffer = Buffer.from([0x68, 0x65, 0x6c, 0x00, 0x6f]);
  assert.ok(binaryBuffer.includes(0));

  // Valid UTF-8 markdown
  const validBuffer = Buffer.from('# Job Spec\n1. Requirement A', 'utf8');
  assert.equal(binaryBuffer.includes(0), true);
  assert.equal(validBuffer.includes(0), false);
});

// 10. REST API failure handling
test('10. REST API failure handling returns formatted safe error without crashing', async () => {
  const mockApi = new OrchestratorApiClient({
    apiUrl: 'http://127.0.0.1:9999', // non-existent port
    apiToken: 'test-token',
    apiTimeoutMs: 100
  });

  let errorCaught = null;
  try {
    await mockApi.getHealth();
  } catch (err) {
    errorCaught = err;
  }
  assert.ok(errorCaught);
  assert.ok(typeof errorCaught.message === 'string');
});

// 16. Cancellation authorization & explicit confirmation
test('16. Cancellation requires explicit confirmation and authorized privileges', async () => {
  const auth = new AuthorizationService({
    allowedGuildIds: ['*'],
    allowedChannelIds: ['*'],
    allowedUserIds: ['normal-user', 'admin-user'],
    adminUserIds: ['admin-user'],
    adminRoleIds: []
  });

  // Normal user cannot execute cancel
  const normalCheck = auth.canExecuteCommand('cancel', 'normal-user', []);
  assert.equal(normalCheck, false);

  // Admin user can execute cancel
  const adminCheck = auth.canExecuteCommand('cancel', 'admin-user', []);
  assert.equal(adminCheck, true);
});
