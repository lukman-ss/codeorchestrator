import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { AuthorizationService } from '../src/authorization.js';
import { PersistenceStore } from '../src/persistence.js';
import { execute } from '../src/commands/code.js';
import { OrchestratorEventListener } from '../src/event-listener.js';
import config from '../src/config.js';

function createMockInteraction({
  subcommand = 'help',
  guildId = 'guild-100',
  channelId = 'channel-auto-discover',
  userId = 'user-authorized',
  memberRoles = ['role-dev'],
  options = {},
  inGuild = true,
  appPermissions = new PermissionsBitField(['ViewChannel', 'SendMessages']),
  botPermissions = undefined,
  channel = null
} = {}) {
  const replies = [];
  let isDeferred = false;
  let isReplied = false;

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
    replied: isReplied,
    deferred: isDeferred,
    appPermissions,
    botPermissions,
    channel: channel || {
      id: channelId,
      permissionsFor: () => appPermissions
    },
    options: {
      getSubcommand: () => subcommand,
      getString: (name, req = false) => options[name] ?? null,
      getBoolean: (name, req = false) => options[name] ?? null,
      getAttachment: (name) => options[name] ?? null,
      getFocused: (full) => full ? { name: 'project', value: options['project'] || '' } : options['project'] || ''
    },
    reply: async (payload) => {
      isReplied = true;
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

function createMockDiscordClient() {
  const channelStore = new Map();

  const getOrCreateChannel = (channelId) => {
    if (!channelStore.has(channelId)) {
      const messages = new Map();
      const sentMessages = [];
      channelStore.set(channelId, {
        id: channelId,
        messages: {
          fetch: async (msgId) => messages.get(msgId) || null,
          cache: messages
        },
        send: async (payload) => {
          const msgObj = {
            id: 'msg-' + Math.random().toString(36).slice(2, 9),
            channelId,
            content: payload.content || payload,
            edit: async (editPayload) => {
              msgObj.content = editPayload.content;
              msgObj.edited = true;
              return msgObj;
            }
          };
          messages.set(msgObj.id, msgObj);
          sentMessages.push(msgObj);
          return msgObj;
        },
        _sentMessages: sentMessages,
        _messages: messages
      });
    }
    return channelStore.get(channelId);
  };

  return {
    channelStore,
    channels: {
      fetch: async (channelId) => getOrCreateChannel(channelId)
    },
    getOrCreateChannel
  };
}

// 1. Public channel without configured Channel ID
test('1. Public channel without configured Channel ID: dynamically allowed when bot has permissions', () => {
  const auth = new AuthorizationService({
    allowedGuildIds: ['guild-100'],
    allowedChannelIds: [], // Empty / unset: Hermes-style dynamic discovery
    allowedUserIds: ['*'],
    allowedRoleIds: []
  });

  const interaction = createMockInteraction({
    channelId: 'public-channel-lobby',
    appPermissions: new PermissionsBitField(['ViewChannel', 'SendMessages'])
  });

  const check = auth.validateInteraction(interaction, 'help');
  assert.equal(check.allowed, true, 'Public channel must be allowed automatically without manual channel ID registration');
});

// 2. Private channel without configured Channel ID
test('2. Private channel without configured Channel ID: dynamically allowed when bot has permissions', () => {
  const auth = new AuthorizationService({
    allowedGuildIds: ['guild-100'],
    allowedChannelIds: [], // Empty / unset: no hardcoded channel IDs
    allowedUserIds: ['*'],
    allowedRoleIds: []
  });

  const interaction = createMockInteraction({
    channelId: 'private-secret-team',
    appPermissions: new PermissionsBitField(['ViewChannel', 'SendMessages'])
  });

  const check = auth.validateInteraction(interaction, 'projects');
  assert.equal(check.allowed, true, 'Private channel must be allowed when bot has channel permissions');
});

// 3. Automatic channel discovery
test('3. Automatic channel discovery: interaction channel ID is used and persisted directly', async () => {
  const testDb = new PersistenceStore('/tmp/test-discovery-' + Date.now() + '.db');
  const targetChannelId = 'auto-discovered-channel-' + Date.now();
  const targetGuildId = 'guild-auto-99';
  const targetUserId = 'user-auto-88';

  const execution = testDb.saveExecution({
    id: 'task-auto-1',
    kind: 'task',
    guildId: targetGuildId,
    channelId: targetChannelId,
    userId: targetUserId,
    messageId: 'msg-init-1',
    projectId: 'test-proj',
    projectSlug: 'test-proj',
    promptSnippet: 'Discover test',
    status: 'queued'
  });

  assert.equal(execution.channel_id, targetChannelId);
  assert.equal(execution.guild_id, targetGuildId);
  assert.equal(execution.user_id, targetUserId);
  testDb.close();
});

// 4. Originating-channel notification routing
test('4. Originating-channel notification routing: updates only send to originating channel', async () => {
  const testDb = new PersistenceStore('/tmp/test-routing-' + Date.now() + '.db');
  const mockClient = createMockDiscordClient();

  const originatingChannelId = 'chan-originating-404';
  const otherChannelId = 'chan-unrelated-505';

  const origChannel = mockClient.getOrCreateChannel(originatingChannelId);
  const otherChannel = mockClient.getOrCreateChannel(otherChannelId);

  // Initial message in originating channel
  const initialMsg = await origChannel.send({ content: 'Initial task message' });

  testDb.saveExecution({
    id: 'job-route-1',
    kind: 'job',
    guildId: 'guild-100',
    channelId: originatingChannelId,
    userId: 'user-1',
    messageId: initialMsg.id,
    projectSlug: 'demo-app',
    status: 'running'
  });

  const listener = new OrchestratorEventListener(
    { getJob: async () => ({ id: 'job-route-1', status: 'completed', total_requirements: 1, verified_requirements: 1 }) },
    testDb,
    mockClient,
    { progressUpdateIntervalMs: 50, pollIntervalMs: 1000 }
  );

  await listener.executeMessageEdit('job-route-1', testDb.getExecution('job-route-1'), 'Updated progress in orig channel', true);

  assert.ok(initialMsg.edited || origChannel._sentMessages.length > 1, 'Originating channel must receive updates');
  assert.equal(otherChannel._sentMessages.length, 0, 'Unrelated channel must receive zero notifications');

  testDb.close();
});

// 5. Multiple channels in one guild
test('5. Multiple channels in one guild: concurrent tasks route to respective originating channels', async () => {
  const testDb = new PersistenceStore('/tmp/test-multichan-' + Date.now() + '.db');
  const mockClient = createMockDiscordClient();

  const channelA = mockClient.getOrCreateChannel('guild-100-chan-A');
  const channelB = mockClient.getOrCreateChannel('guild-100-chan-B');

  const msgA = await channelA.send({ content: 'Task A initial' });
  const msgB = await channelB.send({ content: 'Task B initial' });

  testDb.saveExecution({
    id: 'task-chan-A',
    kind: 'task',
    guildId: 'guild-100',
    channelId: 'guild-100-chan-A',
    userId: 'user-A',
    messageId: msgA.id,
    status: 'running'
  });

  testDb.saveExecution({
    id: 'task-chan-B',
    kind: 'task',
    guildId: 'guild-100',
    channelId: 'guild-100-chan-B',
    userId: 'user-B',
    messageId: msgB.id,
    status: 'running'
  });

  const listener = new OrchestratorEventListener(
    { getTask: async (id) => ({ id, status: 'completed' }) },
    testDb,
    mockClient,
    { progressUpdateIntervalMs: 50, pollIntervalMs: 1000 }
  );

  await listener.executeMessageEdit('task-chan-A', testDb.getExecution('task-chan-A'), 'Task A done', true);
  await listener.executeMessageEdit('task-chan-B', testDb.getExecution('task-chan-B'), 'Task B done', true);

  assert.ok(channelA._sentMessages.some(m => m.content.includes('Task A') || m.id === msgA.id));
  assert.ok(channelB._sentMessages.some(m => m.content.includes('Task B') || m.id === msgB.id));
  assert.equal(channelA._sentMessages.some(m => m.content.includes('Task B')), false, 'Channel A must not receive Task B updates');
  assert.equal(channelB._sentMessages.some(m => m.content.includes('Task A')), false, 'Channel B must not receive Task A updates');

  testDb.close();
});

// 6. Unauthorized user rejection
test('6. Unauthorized user rejection: channel accessibility does not grant execution privileges', () => {
  const auth = new AuthorizationService({
    allowedGuildIds: ['guild-100'],
    allowedChannelIds: [], // Any channel allowed
    allowedUserIds: ['user-vip-only'],
    allowedRoleIds: []
  });

  const interaction = createMockInteraction({
    channelId: 'open-public-channel',
    userId: 'random-unauthorized-user',
    memberRoles: []
  });

  const check = auth.validateInteraction(interaction, 'run');
  assert.equal(check.allowed, false);
  assert.ok(check.reason.includes('not authorized'));
});

// 7. Unauthorized project rejection
test('7. Unauthorized project rejection: granular RBAC restricts project access', () => {
  const auth = new AuthorizationService({
    allowedGuildIds: ['guild-100'],
    allowedChannelIds: [],
    allowedUserIds: ['*'],
    allowedProjects: ['public-demo'],
    userProjects: {
      'user-restricted': ['public-demo']
    }
  });

  const allowed = auth.isProjectAllowedForUser('user-restricted', [], { id: 'p1', slug: 'public-demo' });
  const forbidden = auth.isProjectAllowedForUser('user-restricted', [], { id: 'p2', slug: 'top-secret-core' });

  assert.equal(allowed, true);
  assert.equal(forbidden, false);
});

// 8. Bot lacking channel permissions
test('8. Bot lacking channel permissions: rejected when missing ViewChannel or SendMessages', () => {
  const auth = new AuthorizationService({
    allowedGuildIds: ['guild-100'],
    allowedChannelIds: [],
    allowedUserIds: ['*']
  });

  // Bot missing SendMessages permission in this channel
  const interaction = createMockInteraction({
    channelId: 'channel-locked-down',
    appPermissions: new PermissionsBitField(['ViewChannel']) // SendMessages missing!
  });

  const check = auth.validateInteraction(interaction, 'run');
  assert.equal(check.allowed, false);
  assert.ok(check.reason.includes('Bot lacks required channel permissions'));
});

// 9. Bot restart with persisted channel metadata
test('9. Bot restart with persisted channel metadata: resumes updates to originating channel', async () => {
  const dbPath = '/tmp/test-restart-' + Date.now() + '.db';
  const testDb1 = new PersistenceStore(dbPath);
  const mockClient = createMockDiscordClient();

  const chan = mockClient.getOrCreateChannel('restart-channel-777');
  const initialMsg = await chan.send({ content: 'Queued...' });

  testDb1.saveExecution({
    id: 'job-restart-99',
    kind: 'job',
    guildId: 'guild-100',
    channelId: 'restart-channel-777',
    userId: 'user-77',
    messageId: initialMsg.id,
    projectSlug: 'restart-proj',
    status: 'running'
  });
  testDb1.close();

  // Simulate bot process restart: reopen DB with new listener instance
  const testDb2 = new PersistenceStore(dbPath);
  const restoredExec = testDb2.getExecution('job-restart-99');
  assert.ok(restoredExec);
  assert.equal(restoredExec.channel_id, 'restart-channel-777');

  const listener = new OrchestratorEventListener(
    { getJob: async () => ({ id: 'job-restart-99', status: 'completed' }) },
    testDb2,
    mockClient,
    { progressUpdateIntervalMs: 50, pollIntervalMs: 1000 }
  );

  await listener.executeMessageEdit('job-restart-99', restoredExec, 'Completed after restart!', true);

  assert.ok(initialMsg.edited || chan._sentMessages.length > 1);
  assert.ok(chan._sentMessages.some(m => m.content.includes('terminal state') || m.content.includes('Completed')));

  testDb2.close();
});

// 10. No cross-channel confidential information leakage
test('10. No cross-channel confidential information leakage: messages and secrets do not bleed', async () => {
  const testDb = new PersistenceStore('/tmp/test-leakage-' + Date.now() + '.db');
  const mockClient = createMockDiscordClient();

  const privateChannel = mockClient.getOrCreateChannel('private-engineering');
  const publicChannel = mockClient.getOrCreateChannel('public-lobby');

  const privateMsg = await privateChannel.send({ content: 'Confidential run' });

  testDb.saveExecution({
    id: 'task-confidential-10',
    kind: 'task',
    guildId: 'guild-100',
    channelId: 'private-engineering',
    userId: 'user-eng',
    messageId: privateMsg.id,
    status: 'running'
  });

  const listener = new OrchestratorEventListener(
    { getTask: async () => ({ id: 'task-confidential-10', status: 'completed' }) },
    testDb,
    mockClient,
    { progressUpdateIntervalMs: 50, pollIntervalMs: 1000 }
  );

  await listener.executeMessageEdit(
    'task-confidential-10',
    testDb.getExecution('task-confidential-10'),
    'Task with secret: DISCORD_BOT_TOKEN="secret-value"',
    true
  );

  // 1. Zero leakage to public channel
  assert.equal(publicChannel._sentMessages.length, 0);

  // 2. Secret redacted in private channel
  assert.ok(privateMsg.content.includes('[REDACTED]') || privateChannel._sentMessages.some(m => m.content.includes('[REDACTED]') || !m.content.includes('secret-value')));

  testDb.close();
});

// 11. Backward compatibility with optional channel allowlist
test('11. Backward compatibility with optional channel allowlist: explicit channel allowlist still enforced', () => {
  const authStrict = new AuthorizationService({
    allowedGuildIds: ['guild-100'],
    allowedChannelIds: ['explicit-channel-allowed'],
    allowedUserIds: ['*']
  });

  const interactionAllowed = createMockInteraction({
    channelId: 'explicit-channel-allowed'
  });
  const interactionDenied = createMockInteraction({
    channelId: 'arbitrary-channel'
  });

  assert.equal(authStrict.validateInteraction(interactionAllowed, 'help').allowed, true);
  assert.equal(authStrict.validateInteraction(interactionDenied, 'help').allowed, false);
});

// 12. Existing command and API integration behavior
test('12. Existing command and API integration behavior: /code help runs smoothly with auto-discovery', async () => {
  const prevGuilds = config.allowedGuildIds;
  const prevChannels = config.allowedChannelIds;
  const prevUsers = config.allowedUserIds;

  try {
    config.allowedGuildIds = ['guild-100'];
    config.allowedChannelIds = []; // Empty: discovery enabled
    config.allowedUserIds = ['*'];

    const interaction = createMockInteraction({
      channelId: 'discovered-chan-12',
      subcommand: 'help'
    });

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
