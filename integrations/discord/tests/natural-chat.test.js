import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import {
  cleanPrompt,
  isChatEligible,
  serializeSession,
  handleMessage
} from '../src/natural-chat.js';
import { PersistenceStore } from '../src/persistence.js';
import { AuthorizationService } from '../src/authorization.js';
import { execute as executeSlashCommand } from '../src/commands/code.js';

function createMockAuth(overrides = {}) {
  return new AuthorizationService({
    allowedGuildIds: ['guild-100'],
    allowedChannelIds: [],
    allowedUserIds: ['*'],
    allowedRoleIds: ['*'],
    ...overrides
  });
}

function createMockPersistence() {
  return new PersistenceStore(':memory:');
}

function createMockApiClient(overrides = {}) {
  const sessions = new Map();
  const messages = new Map();

  return {
    sessions,
    messages,
    async createSession(payload) {
      if (overrides.createSession) return overrides.createSession(payload);
      const id = 'sess-' + Math.random().toString(36).slice(2, 9);
      const session = {
        id,
        title: payload.title || 'Untitled Session',
        session_type: payload.type || (payload.projectId ? 'project' : 'standalone'),
        project_id: payload.projectId || null,
        model: payload.model || null,
        user_id: payload.userId || null,
        status: 'idle',
        opencode_session_id: 'opencode-' + id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      sessions.set(id, session);
      return session;
    },
    async getSession(id) {
      if (overrides.getSession) return overrides.getSession(id);
      const s = sessions.get(id);
      if (!s) {
        const err = new Error(`Session ${id} not found`);
        err.statusCode = 404;
        throw err;
      }
      return s;
    },
    async resolveSession(idOrTitle) {
      if (overrides.resolveSession) return overrides.resolveSession(idOrTitle);
      return sessions.get(idOrTitle) || null;
    },
    async updateSession(id, patch) {
      if (overrides.updateSession) return overrides.updateSession(id, patch);
      const s = sessions.get(id);
      if (s) {
        Object.assign(s, patch, { updated_at: new Date().toISOString() });
        return s;
      }
      throw new Error('Not found');
    },
    async getSessionMessages(id) {
      if (overrides.getSessionMessages) return overrides.getSessionMessages(id);
      return messages.get(id) || [];
    },
    async sendSessionMessage(sessionId, payload, timeoutMs) {
      if (overrides.sendSessionMessage) return overrides.sendSessionMessage(sessionId, payload, timeoutMs);
      const s = sessions.get(sessionId);
      if (!s) throw new Error('Session not found');
      if (s.status === 'closed') throw new Error('Cannot send message to closed session');

      const userMsg = { role: 'user', content: payload.prompt, created_at: new Date().toISOString() };
      const assistantText = `Response from ${sessionId}: processed "${payload.prompt}"`;
      const assistantMsg = { role: 'assistant', content: assistantText, created_at: new Date().toISOString() };

      const list = messages.get(sessionId) || [];
      list.push(userMsg, assistantMsg);
      messages.set(sessionId, list);

      return {
        session: s,
        response: assistantText,
        status: 'idle'
      };
    }
  };
}

function createMockDiscordMessage({
  id = 'msg-' + Math.random().toString(36).slice(2, 9),
  content = '',
  guildId = 'guild-100',
  channelId = 'channel-200',
  userId = 'user-alice',
  roles = ['role-dev'],
  botId = 'bot-agent-coding',
  isMention = false,
  referencedMessage = null,
  reference = null,
  isThread = false,
  isBot = false,
  webhookId = null
} = {}) {
  const sentInChannel = [];
  const replies = [];

  const mentionsUsers = new Map();
  if (isMention) {
    mentionsUsers.set(botId, { id: botId, bot: true });
  }

  const permissions = new PermissionsBitField(['ViewChannel', 'SendMessages']);

  const channelObj = {
    id: channelId,
    parentId: isThread ? 'parent-channel-100' : null,
    isThread: () => isThread,
    permissionsFor: () => permissions,
    sendTyping: async () => true,
    send: async (payload) => {
      const msg = {
        id: 'msg-reply-' + Math.random().toString(36).slice(2, 9),
        content: payload.content || '',
        files: payload.files || [],
        channelId
      };
      sentInChannel.push(msg);
      return msg;
    },
    messages: {
      fetch: async (msgId) => {
        if (referencedMessage && referencedMessage.id === msgId) {
          return referencedMessage;
        }
        return null;
      }
    }
  };

  const msg = {
    id,
    content,
    guildId,
    channelId,
    botPermissions: true,
    appPermissions: permissions,
    channel: channelObj,
    webhookId,
    author: {
      id: userId,
      bot: isBot,
      tag: `User#${userId}`
    },
    member: {
      roles: {
        cache: new Map(roles.map(r => [r, { id: r }]))
      }
    },
    mentions: {
      users: mentionsUsers,
      has: (checkId) => checkId === botId && isMention
    },
    reference: reference || (referencedMessage ? { messageId: referencedMessage.id } : null),
    referencedMessage,
    reply: async (payload) => {
      const replyObj = {
        id: 'msg-reply-' + Math.random().toString(36).slice(2, 9),
        content: payload.content || '',
        files: payload.files || [],
        channelId
      };
      replies.push(replyObj);
      return replyObj;
    },
    _replies: replies,
    _sentInChannel: sentInChannel
  };

  return msg;
}

function createMockClient(botId = 'bot-agent-coding') {
  return {
    user: {
      id: botId,
      tag: 'Agent Coding#9401'
    }
  };
}

// 1. Mention with text triggers conversation and cleans prompt
test('1. Natural Chat: bot mention triggers conversation and cleans prompt', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: `<@${client.user.id}> explain binary search algorithm`,
    isMention: true,
    userId: 'user-alice'
  });

  const result = await handleMessage(msg, client, apiClient, persistence, auth);
  assert.ok(result);
  assert.equal(msg._replies.length, 1);
  assert.ok(msg._replies[0].content.includes('explain binary search algorithm'));

  // Prompt stripped of <@botId>
  assert.equal(cleanPrompt(msg.content, client.user.id), 'explain binary search algorithm');
  persistence.close();
});

// 2. Direct reply to bot message continues the conversation
test('2. Natural Chat: direct reply to bot message continues conversation', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  // Create initial turn
  const msg1 = createMockDiscordMessage({
    id: 'msg-turn-1',
    content: `<@${client.user.id}> start conversation`,
    isMention: true,
    userId: 'user-alice'
  });
  await handleMessage(msg1, client, apiClient, persistence, auth);
  const botReply1 = msg1._replies[0];

  // Reply to bot's response
  const msg2 = createMockDiscordMessage({
    id: 'msg-turn-2',
    content: 'give an example in javascript',
    userId: 'user-alice',
    isMention: false,
    referencedMessage: { id: botReply1.id, author: { id: client.user.id } }
  });

  const result2 = await handleMessage(msg2, client, apiClient, persistence, auth);
  assert.ok(result2);
  assert.equal(msg2._replies.length, 1);
  assert.ok(msg2._replies[0].content.includes('give an example in javascript'));
  persistence.close();
});

// 3. Multi-turn continuation routes into the exact same OpenCode session
test('3. Natural Chat: multi-turn continuation routes into the exact same OpenCode session', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  const msg1 = createMockDiscordMessage({
    content: `<@${client.user.id}> Step 1`,
    isMention: true,
    userId: 'user-alice'
  });
  await handleMessage(msg1, client, apiClient, persistence, auth);
  const botReply1 = msg1._replies[0];

  const conv = persistence.getActiveConversation({
    guildId: 'guild-100',
    channelId: 'channel-200',
    discordUserId: 'user-alice'
  });
  assert.ok(conv);
  const targetSessionId = conv.session_id;

  const msg2 = createMockDiscordMessage({
    content: 'Step 2',
    userId: 'user-alice',
    referencedMessage: { id: botReply1.id, author: { id: client.user.id } }
  });
  await handleMessage(msg2, client, apiClient, persistence, auth);

  const messages = await apiClient.getSessionMessages(targetSessionId);
  assert.equal(messages.length, 4); // 2 user turns + 2 assistant responses
  assert.equal(messages[0].content, 'Step 1');
  assert.equal(messages[2].content, 'Step 2');
  persistence.close();
});

// 4. Reply to older bot message returns to that original historical session
test('4. Natural Chat: reply to older bot message returns to that historical session', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  // Session A
  const msgA = createMockDiscordMessage({
    content: `<@${client.user.id}> Session A Question`,
    isMention: true,
    userId: 'user-alice'
  });
  await handleMessage(msgA, client, apiClient, persistence, auth);
  const replyA = msgA._replies[0];
  const convA = persistence.getActiveConversation({
    guildId: 'guild-100',
    channelId: 'channel-200',
    discordUserId: 'user-alice'
  });
  const sessionAId = convA.session_id;

  // Manually close Session A to force Session B on next mention
  persistence.closeConversation(convA.id);

  // Session B
  const msgB = createMockDiscordMessage({
    content: `<@${client.user.id}> Session B Question`,
    isMention: true,
    userId: 'user-alice'
  });
  await handleMessage(msgB, client, apiClient, persistence, auth);
  const convB = persistence.getActiveConversation({
    guildId: 'guild-100',
    channelId: 'channel-200',
    discordUserId: 'user-alice'
  });
  const sessionBId = convB.session_id;
  assert.notEqual(sessionAId, sessionBId);

  // Now reply directly to historical Session A's bot reply
  const msgHistory = createMockDiscordMessage({
    content: 'Follow-up to Session A',
    userId: 'user-alice',
    referencedMessage: { id: replyA.id, author: { id: client.user.id } }
  });
  await handleMessage(msgHistory, client, apiClient, persistence, auth);

  // Session A should have received the message, NOT session B
  const msgsA = await apiClient.getSessionMessages(sessionAId);
  const msgsB = await apiClient.getSessionMessages(sessionBId);
  assert.ok(msgsA.some(m => m.content === 'Follow-up to Session A'));
  assert.ok(!msgsB.some(m => m.content === 'Follow-up to Session A'));
  persistence.close();
});

// 5. Default conversation scope: one active standalone session per user per channel
test('5. Natural Chat: default scope is one active standalone session per user per channel', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  const msg1 = createMockDiscordMessage({
    channelId: 'channel-general',
    content: `<@${client.user.id}> General channel chat`,
    isMention: true,
    userId: 'user-alice'
  });
  await handleMessage(msg1, client, apiClient, persistence, auth);

  const msg2 = createMockDiscordMessage({
    channelId: 'channel-dev',
    content: `<@${client.user.id}> Dev channel chat`,
    isMention: true,
    userId: 'user-alice'
  });
  await handleMessage(msg2, client, apiClient, persistence, auth);

  const convGeneral = persistence.getActiveConversation({
    guildId: 'guild-100',
    channelId: 'channel-general',
    discordUserId: 'user-alice'
  });
  const convDev = persistence.getActiveConversation({
    guildId: 'guild-100',
    channelId: 'channel-dev',
    discordUserId: 'user-alice'
  });

  assert.ok(convGeneral);
  assert.ok(convDev);
  assert.notEqual(convGeneral.session_id, convDev.session_id);
  persistence.close();
});

// 6. Thread conversation scope: thread gets its own distinct session scope
test('6. Natural Chat: thread conversation scope is isolated from parent channel', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  // Channel session
  const channelMsg = createMockDiscordMessage({
    channelId: 'parent-channel-100',
    isThread: false,
    content: `<@${client.user.id}> Channel session`,
    isMention: true,
    userId: 'user-alice'
  });
  await handleMessage(channelMsg, client, apiClient, persistence, auth);

  // Thread session
  const threadMsg = createMockDiscordMessage({
    channelId: 'thread-999',
    isThread: true,
    content: `<@${client.user.id}> Thread session`,
    isMention: true,
    userId: 'user-alice'
  });
  await handleMessage(threadMsg, client, apiClient, persistence, auth);

  const parentConv = persistence.getActiveConversation({
    guildId: 'guild-100',
    channelId: 'parent-channel-100',
    discordUserId: 'user-alice'
  });
  const threadConv = persistence.getActiveConversation({
    guildId: 'guild-100',
    channelId: 'parent-channel-100',
    threadId: 'thread-999',
    discordUserId: 'user-alice'
  });

  assert.ok(parentConv);
  assert.ok(threadConv);
  assert.notEqual(parentConv.session_id, threadConv.session_id);
  persistence.close();
});

// 7. Privacy / cross-user isolation: User B cannot reply to User A's private standalone session
test('7. Natural Chat: user B cannot reply to or hijack user A private standalone session', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  // User Alice starts private standalone session
  const aliceMsg = createMockDiscordMessage({
    content: `<@${client.user.id}> Alice secret code`,
    isMention: true,
    userId: 'user-alice'
  });
  await handleMessage(aliceMsg, client, apiClient, persistence, auth);
  const botReply = aliceMsg._replies[0];

  // User Bob attempts to reply to Alice's session message
  const bobMsg = createMockDiscordMessage({
    content: 'Show me what Alice asked',
    userId: 'user-bob',
    roles: ['role-dev'],
    referencedMessage: { id: botReply.id, author: { id: client.user.id } }
  });

  await handleMessage(bobMsg, client, apiClient, persistence, auth);
  assert.equal(bobMsg._replies.length, 1);
  assert.ok(bobMsg._replies[0].content.includes('Access Denied'));
  assert.ok(bobMsg._replies[0].content.includes("cannot continue another user's private conversation"));
  persistence.close();
});

// 8. Standalone sessions default with project_id = null
test('8. Natural Chat: standalone sessions default with project_id = null', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: `<@${client.user.id}> What is an abstract syntax tree?`,
    isMention: true,
    userId: 'user-alice'
  });
  await handleMessage(msg, client, apiClient, persistence, auth);

  const conv = persistence.getActiveConversation({
    guildId: 'guild-100',
    channelId: 'channel-200',
    discordUserId: 'user-alice'
  });
  assert.ok(conv);
  assert.equal(conv.project_id, null);
  assert.equal(conv.conversation_type, 'standalone');

  const session = await apiClient.getSession(conv.session_id);
  assert.equal(session.project_id, null);
  assert.equal(session.session_type, 'standalone');
  persistence.close();
});

// 9. Project-linked session continues in project workspace
test('9. Natural Chat: project-linked session preserves project context', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  // Create project session
  const projectSession = await apiClient.createSession({
    title: 'Project Debugging',
    projectId: 'proj-backend',
    userId: 'user-alice'
  });

  const conv = persistence.createConversation({
    id: 'conv-proj-1',
    guildId: 'guild-100',
    channelId: 'channel-200',
    discordUserId: 'user-alice',
    sessionId: projectSession.id,
    projectId: 'proj-backend',
    conversationType: 'project',
    status: 'active'
  });

  const botMsgId = 'bot-proj-msg-1';
  persistence.saveSessionMessage({
    id: 'smsg-1',
    conversationId: conv.id,
    sessionId: projectSession.id,
    discordMessageId: botMsgId,
    messageRole: 'assistant',
    status: 'completed'
  });

  // Reply to project session message
  const msg = createMockDiscordMessage({
    content: 'Inspect the test files in workspace',
    userId: 'user-alice',
    referencedMessage: { id: botMsgId, author: { id: client.user.id } }
  });

  await handleMessage(msg, client, apiClient, persistence, auth);
  const session = await apiClient.getSession(projectSession.id);
  assert.equal(session.project_id, 'proj-backend');
  assert.equal(session.session_type, 'project');
  persistence.close();
});

// 10. Bot ignores own messages
test('10. Natural Chat: bot ignores own messages', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: 'Self message from bot',
    userId: client.user.id
  });

  const check = isChatEligible(msg, client);
  assert.equal(check.eligible, false);
  assert.equal(check.reason, 'self_message');

  const result = await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(result, null);
  assert.equal(msg._replies.length, 0);
  persistence.close();
});

// 11. Bot ignores other bot messages
test('11. Natural Chat: bot ignores messages from other bots', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: `<@${client.user.id}> Bot ping`,
    isMention: true,
    isBot: true,
    userId: 'other-bot-id'
  });

  const check = isChatEligible(msg, client);
  assert.equal(check.eligible, false);
  assert.equal(check.reason, 'bot_or_webhook');

  const result = await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(result, null);
  assert.equal(msg._replies.length, 0);
  persistence.close();
});

// 12. Bot ignores webhook messages
test('12. Natural Chat: bot ignores webhook messages', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: `<@${client.user.id}> Webhook payload`,
    isMention: true,
    webhookId: 'webhook-999',
    userId: 'webhook-user'
  });

  const check = isChatEligible(msg, client);
  assert.equal(check.eligible, false);
  assert.equal(check.reason, 'bot_or_webhook');

  const result = await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(result, null);
  persistence.close();
});

// 13. Bot ignores DM messages
test('13. Natural Chat: bot ignores DM messages (missing guildId)', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: `<@${client.user.id}> DM message`,
    isMention: true,
    guildId: null
  });

  const check = isChatEligible(msg, client);
  assert.equal(check.eligible, false);
  assert.equal(check.reason, 'dm_unsupported');

  const result = await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(result, null);
  persistence.close();
});

// 14. Ambient channel chat without mention or bot reply is ignored
test('14. Natural Chat: ambient channel chat without mention or reply is ignored', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: 'Just chatting with other team members in channel',
    isMention: false,
    referencedMessage: null
  });

  const check = isChatEligible(msg, client);
  assert.equal(check.eligible, false);
  assert.equal(check.reason, 'no_trigger');

  const result = await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(result, null);
  assert.equal(msg._replies.length, 0);
  persistence.close();
});

// 15. Mention-only sends friendly introductory greeting
test('15. Natural Chat: mention-only without text sends friendly introductory greeting', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: `<@${client.user.id}>`,
    isMention: true,
    userId: 'user-alice'
  });

  await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(msg._replies.length, 1);
  assert.ok(msg._replies[0].content.includes("Hello! I'm Agent Coding"));
  persistence.close();
});

// 16. Direct reply with empty content provides intent guidance warning
test('16. Natural Chat: reply with empty content provides intent guidance warning', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: '',
    userId: 'user-alice',
    referencedMessage: { id: 'some-bot-msg', author: { id: client.user.id } }
  });

  await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(msg._replies.length, 1);
  assert.ok(msg._replies[0].content.includes('Message Content Intent'));
  persistence.close();
});

// 17. Unauthorized user mention/reply receives Access Denied
test('17. Natural Chat: unauthorized user receives Access Denied', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth({ allowedUserIds: ['user-alice'], allowedRoleIds: [] });
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: `<@${client.user.id}> build this project`,
    isMention: true,
    userId: 'unauthorized-user',
    roles: ['role-guest']
  });

  await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(msg._replies.length, 1);
  assert.ok(msg._replies[0].content.includes('Access Denied'));
  assert.ok(msg._replies[0].content.includes('not authorized'));
  persistence.close();
});

// 18. Unauthorized channel mention receives Access Denied
test('18. Natural Chat: unauthorized channel mention receives Access Denied', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth({
    allowedChannelIds: ['channel-allowed-only']
  });
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    channelId: 'channel-forbidden',
    content: `<@${client.user.id}> hello`,
    isMention: true,
    userId: 'user-alice'
  });

  await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(msg._replies.length, 1);
  assert.ok(msg._replies[0].content.includes('Access Denied'));
  assert.ok(msg._replies[0].content.includes('not permitted in this channel'));
  persistence.close();
});

// 19. Unauthorized guild is dropped silently
test('19. Natural Chat: unauthorized guild is dropped silently', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth({
    allowedGuildIds: ['guild-allowed-100']
  });
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    guildId: 'guild-unauthorized-999',
    content: `<@${client.user.id}> ping`,
    isMention: true,
    userId: 'user-alice'
  });

  const result = await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(result, null);
  assert.equal(msg._replies.length, 0);
  persistence.close();
});

// 20. Missing bot channel permissions drops silently without throwing
test('20. Natural Chat: missing bot channel permissions drops message safely', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: `<@${client.user.id}> ping`,
    isMention: true,
    userId: 'user-alice'
  });

  // Strip bot permissions
  msg.botPermissions = false;
  delete msg.appPermissions;
  msg.channel.permissionsFor = () => new PermissionsBitField([]);

  const result = await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(result, null);
  assert.equal(msg._replies.length, 0);
  persistence.close();
});

// 21. Message idempotency: duplicate delivery of running/completed message ID is dropped
test('21. Natural Chat: duplicate message delivery is dropped by idempotency check', async () => {
  const persistence = createMockPersistence();
  let callCount = 0;
  const apiClient = createMockApiClient({
    sendSessionMessage: async () => {
      callCount++;
      return { response: 'Processed once' };
    }
  });
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    id: 'msg-idempotent-1',
    content: `<@${client.user.id}> Run once only`,
    isMention: true,
    userId: 'user-alice'
  });

  // First delivery
  await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(callCount, 1);

  // Redelivery of exact same message ID
  await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(callCount, 1); // Not executed again
  persistence.close();
});

// 22. Execution serialization: concurrent messages on same session are queued sequentially
test('22. Natural Chat: serializeSession serializes concurrent turns on same session', async () => {
  const executionOrder = [];

  const task1 = serializeSession('session-lock-test', async () => {
    executionOrder.push('start-1');
    await new Promise(r => setTimeout(r, 20));
    executionOrder.push('end-1');
    return 'res1';
  });

  const task2 = serializeSession('session-lock-test', async () => {
    executionOrder.push('start-2');
    await new Promise(r => setTimeout(r, 10));
    executionOrder.push('end-2');
    return 'res2';
  });

  const [res1, res2] = await Promise.all([task1, task2]);
  assert.equal(res1, 'res1');
  assert.equal(res2, 'res2');
  assert.deepEqual(executionOrder, ['start-1', 'end-1', 'start-2', 'end-2']);
});

// 23. Multi-chunk handling: responses <= 1900 chars sent in single message
test('23. Natural Chat: response <= 1900 chars sent in single message', async () => {
  const persistence = createMockPersistence();
  const shortResponse = 'X'.repeat(1500);
  const apiClient = createMockApiClient({
    sendSessionMessage: async () => ({ response: shortResponse })
  });
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: `<@${client.user.id}> short response test`,
    isMention: true,
    userId: 'user-alice'
  });

  await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(msg._replies.length, 1);
  assert.equal(msg._sentInChannel.length, 0);
  assert.equal(msg._replies[0].content.length, 1500);
  persistence.close();
});

// 24. Multi-chunk handling: responses between 1901 and 3 chunks sent as sequential messages
test('24. Natural Chat: response across 2-3 chunks sends reply and channel sends', async () => {
  const persistence = createMockPersistence();
  // ~3500 chars splits into 2 chunks
  const twoChunkResponse = 'Word '.repeat(700);
  const apiClient = createMockApiClient({
    sendSessionMessage: async () => ({ response: twoChunkResponse })
  });
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: `<@${client.user.id}> two chunk test`,
    isMention: true,
    userId: 'user-alice'
  });

  await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(msg._replies.length, 1); // Chunk 0
  assert.equal(msg._sentInChannel.length, 1); // Chunk 1
  assert.ok(msg._replies[0].content.length <= 1900);
  assert.ok(msg._sentInChannel[0].content.length <= 1900);
  persistence.close();
});

// 25. Multi-chunk handling: responses > 3 chunks attach .txt file
test('25. Natural Chat: responses > 3 chunks attach .txt file', async () => {
  const persistence = createMockPersistence();
  // ~8000 chars splits into 5 chunks (> 3 chunks threshold)
  const hugeResponse = 'Long line of code analysis.\n'.repeat(300);
  const apiClient = createMockApiClient({
    sendSessionMessage: async () => ({ response: hugeResponse })
  });
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    content: `<@${client.user.id}> massive response test`,
    isMention: true,
    userId: 'user-alice'
  });

  await handleMessage(msg, client, apiClient, persistence, auth);
  assert.equal(msg._replies.length, 1);
  assert.ok(msg._replies[0].content.includes('(Full response attached)'));
  assert.equal(msg._replies[0].files.length, 1);
  assert.equal(msg._replies[0].files[0].name, 'response.txt');
  persistence.close();
});

// 26. Multi-chunk persistence: all chunk message IDs recorded in discord_session_messages
test('26. Natural Chat: all chunk message IDs recorded in persistence', async () => {
  const persistence = createMockPersistence();
  const twoChunkResponse = 'Chunked content '.repeat(200);
  const apiClient = createMockApiClient({
    sendSessionMessage: async () => ({ response: twoChunkResponse })
  });
  const auth = createMockAuth();
  const client = createMockClient();

  const msg = createMockDiscordMessage({
    id: 'user-trigger-msg',
    content: `<@${client.user.id}> chunk persistence test`,
    isMention: true,
    userId: 'user-alice'
  });

  await handleMessage(msg, client, apiClient, persistence, auth);

  // User message recorded
  const userRec = persistence.getSessionMessage('user-trigger-msg');
  assert.ok(userRec);
  assert.equal(userRec.status, 'completed');

  // Assistant chunk 0 recorded
  const reply0 = msg._replies[0];
  const chunk0Rec = persistence.getSessionMessage(reply0.id);
  assert.ok(chunk0Rec);
  assert.equal(chunk0Rec.message_role, 'assistant');
  assert.equal(chunk0Rec.status, 'completed');

  // Assistant chunk 1 recorded
  if (msg._sentInChannel.length > 0) {
    const chunk1Rec = persistence.getSessionMessage(msg._sentInChannel[0].id);
    assert.ok(chunk1Rec);
    assert.equal(chunk1Rec.message_role, 'assistant');
    assert.equal(chunk1Rec.status, 'completed');
  }
  persistence.close();
});

// 27. Session close via /code session close archives session; next mention creates fresh session
test('27. Natural Chat: session close archives conversation and next mention creates fresh session', async () => {
  const persistence = createMockPersistence();
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = createMockClient();

  // 1. Initial chat creates active conversation
  const msg1 = createMockDiscordMessage({
    content: `<@${client.user.id}> Initial chat topic`,
    isMention: true,
    userId: 'user-alice'
  });
  await handleMessage(msg1, client, apiClient, persistence, auth);

  const initialConv = persistence.getActiveConversation({
    guildId: 'guild-100',
    channelId: 'channel-200',
    discordUserId: 'user-alice'
  });
  assert.ok(initialConv);
  const firstSessionId = initialConv.session_id;

  // 2. Close session
  persistence.closeConversation(initialConv.id);
  await apiClient.updateSession(firstSessionId, { status: 'closed' });

  // Verify conversation is closed
  const activeAfterClose = persistence.getActiveConversation({
    guildId: 'guild-100',
    channelId: 'channel-200',
    discordUserId: 'user-alice'
  });
  assert.equal(activeAfterClose, undefined);

  // 3. Next mention starts a brand new session
  const msg2 = createMockDiscordMessage({
    content: `<@${client.user.id}> Fresh new chat topic`,
    isMention: true,
    userId: 'user-alice'
  });
  await handleMessage(msg2, client, apiClient, persistence, auth);

  const freshConv = persistence.getActiveConversation({
    guildId: 'guild-100',
    channelId: 'channel-200',
    discordUserId: 'user-alice'
  });
  assert.ok(freshConv);
  assert.notEqual(freshConv.session_id, firstSessionId);
  persistence.close();
});

// 28. Restart reconciliation: reconcileRunningMessages() transitions incomplete messages to failed
test('28. Natural Chat: restart reconciliation transitions running/queued messages to failed', () => {
  const persistence = createMockPersistence();

  // Insert messages in received, running, and completed states
  persistence.saveSessionMessage({
    id: 'm1',
    conversationId: 'c1',
    sessionId: 's1',
    discordMessageId: 'msg-rec',
    messageRole: 'user',
    status: 'received'
  });

  persistence.saveSessionMessage({
    id: 'm2',
    conversationId: 'c1',
    sessionId: 's1',
    discordMessageId: 'msg-run',
    messageRole: 'user',
    status: 'running'
  });

  persistence.saveSessionMessage({
    id: 'm3',
    conversationId: 'c1',
    sessionId: 's1',
    discordMessageId: 'msg-comp',
    messageRole: 'assistant',
    status: 'completed'
  });

  // Reconcile
  persistence.reconcileRunningMessages();

  assert.equal(persistence.getSessionMessage('msg-rec').status, 'failed');
  assert.equal(persistence.getSessionMessage('msg-run').status, 'failed');
  assert.ok(persistence.getSessionMessage('msg-run').error.includes('restart'));
  assert.equal(persistence.getSessionMessage('msg-comp').status, 'completed');
  persistence.close();
});
