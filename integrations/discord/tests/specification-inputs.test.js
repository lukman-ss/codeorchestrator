import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { PermissionsBitField } from 'discord.js';

import {
  downloadAndValidateAttachment,
  savePromptArtifact,
  ensureArtifactsDirectory
} from '../src/attachment-service.js';
import { PersistenceStore } from '../src/persistence.js';
import defaultPersistence from '../src/persistence.js';
import defaultApiClient from '../src/api-client.js';
import { AuthorizationService } from '../src/authorization.js';
import config from '../src/config.js';
import {
  formatSpecificationCard,
  formatExecutionStartedCard,
  formatExecutionResultCard
} from '../src/notifications.js';
import { handleMessage } from '../src/natural-chat.js';
import { execute as executeSlashCommand, handleButton } from '../src/commands/code.js';
import { validateProjectWorkspace, repairProject } from '../../../src/services/project-service.js';

function createMockAuth(overrides = {}) {
  return new AuthorizationService({
    allowedGuildIds: ['guild-100'],
    allowedChannelIds: [],
    allowedUserIds: ['*'],
    allowedRoleIds: ['*'],
    ...overrides
  });
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
  attachments = [],
  referencedMessage = null,
  reference = null,
  isThread = false
} = {}) {
  const sentInChannel = [];
  const replies = [];
  const reactions = [];

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
        components: payload.components || [],
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

  const attMap = new Map();
  attachments.forEach((att, idx) => attMap.set(att.id || String(idx), att));

  const msg = {
    id,
    content,
    guildId,
    channelId,
    botPermissions: true,
    appPermissions: permissions,
    member: {
      id: userId,
      roles: {
        cache: new Map(roles.map(r => [r, { id: r }]))
      }
    },
    author: {
      id: userId,
      bot: false
    },
    mentions: {
      users: mentionsUsers,
      has: (uid) => uid === botId && isMention
    },
    attachments: attMap,
    reference: reference || (referencedMessage ? { messageId: referencedMessage.id } : null),
    referencedMessage,
    channel: channelObj,
    react: async (emoji) => {
      reactions.push(emoji);
      return true;
    },
    reply: async (payload) => {
      const replyMsg = {
        id: 'msg-ack-' + Math.random().toString(36).slice(2, 9),
        content: typeof payload === 'string' ? payload : (payload.content || ''),
        files: payload.files || [],
        components: payload.components || [],
        channelId
      };
      replies.push(replyMsg);
      return replyMsg;
    },
    _replies: replies,
    _sentInChannel: sentInChannel,
    _reactions: reactions
  };

  return msg;
}

function createMockApiClient() {
  const sessions = new Map();
  const projects = new Map();

  return {
    sessions,
    projects,
    async createSession(payload) {
      const id = 'sess-' + Math.random().toString(36).slice(2, 9);
      const session = {
        id,
        title: payload.title || 'Untitled Session',
        session_type: payload.type || (payload.projectId ? 'project' : 'standalone'),
        project_id: payload.projectId || null,
        model: payload.model || null,
        user_id: payload.userId || null,
        status: 'idle',
        opencode_session_id: 'opencode-' + id
      };
      sessions.set(id, session);
      return session;
    },
    async getSession(id) {
      const s = sessions.get(id);
      if (!s) throw new Error(`Session ${id} not found`);
      return s;
    },
    async sendSessionMessage(sessionId, payload) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error('Session not found');
      return { session: s, response: `Processed prompt (${payload.prompt.length} bytes)`, status: 'completed' };
    },
    async resolveProject(idOrSlug) {
      return projects.get(idOrSlug) || null;
    },
    async getProject(id) {
      const p = projects.get(id);
      if (!p) throw new Error(`Project ${id} not found`);
      return p;
    },
    async validateProject(id) {
      const p = projects.get(id);
      if (!p) throw new Error('Project not found');
      return validateProjectWorkspace(p);
    },
    async repairProject(id, params) {
      return repairProject(id, params);
    },
    async createTask(projectId, payload) {
      return { id: 'task-' + Math.random().toString(36).slice(2, 9), status: 'queued' };
    },
    async createJob(projectId, prompt) {
      return { id: 'job-' + Math.random().toString(36).slice(2, 9), status: 'planning', total_requirements: 4 };
    }
  };
}

// Global fetch mock helper
let originalFetch = globalThis.fetch;
function mockFetch(handler) {
  globalThis.fetch = async (url, opts) => handler(url, opts);
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test('1. Normal mention without attachment executes conversational turn', async () => {
  const persistence = new PersistenceStore(':memory:');
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = { user: { id: 'bot-agent-coding' } };

  const msg = createMockDiscordMessage({
    isMention: true,
    content: '<@bot-agent-coding> Explain binary search in one line'
  });

  const res = await handleMessage(msg, client, apiClient, persistence, auth);
  assert.ok(res);
  assert.equal(msg._replies.length, 1);
  assert.match(msg._replies[0].content, /Processed prompt/);
  persistence.close();
});

test('2. Reply with attachment resumes existing session context and stages submission', async () => {
  const persistence = new PersistenceStore(':memory:');
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = { user: { id: 'bot-agent-coding' } };

  // Setup existing session and bot message
  const session = await apiClient.createSession({ title: 'Active Chat' });
  const botMsgId = 'bot-msg-123';
  persistence.saveSessionMessage({
    id: 'smsg-1',
    conversationId: 'conv-1',
    sessionId: session.id,
    discordMessageId: botMsgId,
    messageRole: 'assistant',
    status: 'completed'
  });

  mockFetch(async (url) => {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => Buffer.from('# Architecture Spec\nFollow all steps exactly.', 'utf8')
    };
  });

  try {
    const replyMsg = createMockDiscordMessage({
      content: 'Here is the follow-up specification',
      reference: { messageId: botMsgId },
      attachments: [{
        id: 'att-1',
        name: 'spec.md',
        size: 45,
        url: 'https://cdn.discordapp.com/attachments/100/spec.md'
      }]
    });

    const res = await handleMessage(replyMsg, client, apiClient, persistence, auth);
    assert.ok(res);
    assert.equal(replyMsg._replies.length, 1);
    assert.match(replyMsg._replies[0].content, /Specification Received/);

    // Verify submission record
    const sub = persistence.getSubmissionByMessageId(replyMsg._replies[0].id);
    assert.ok(sub);
    assert.equal(sub.input_method, 'reply_with_attachment');
    assert.equal(sub.session_id, session.id);
    assert.equal(sub.status, 'received');
  } finally {
    restoreFetch();
    persistence.close();
  }
});

test('3. Mention with attachment stages submission for standalone session', async () => {
  const persistence = new PersistenceStore(':memory:');
  const apiClient = createMockApiClient();
  const auth = createMockAuth();
  const client = { user: { id: 'bot-agent-coding' } };

  mockFetch(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => Buffer.from('Build an audit logger in Go', 'utf8')
  }));

  try {
    const msg = createMockDiscordMessage({
      isMention: true,
      content: '<@bot-agent-coding> Please review this specification',
      attachments: [{
        id: 'att-2',
        name: 'requirements.txt',
        size: 27,
        url: 'https://media.discordapp.net/attachments/100/requirements.txt'
      }]
    });

    const res = await handleMessage(msg, client, apiClient, persistence, auth);
    assert.ok(res);
    assert.equal(msg._replies.length, 1);
    assert.match(msg._replies[0].content, /Specification Received/);

    const sub = persistence.getSubmissionByMessageId(msg._replies[0].id);
    assert.ok(sub);
    assert.equal(sub.input_method, 'mention_with_attachment');
    assert.equal(sub.status, 'received');
    assert.ok(sub.artifact_path);
  } finally {
    restoreFetch();
    persistence.close();
  }
});

test('4. Multipart prompt lifecycle: start, chunk collection, submit', async () => {
  const prevGuilds = config.allowedGuildIds;
  const prevChannels = config.allowedChannelIds;
  const prevUsers = config.allowedUserIds;

  try {
    config.allowedGuildIds = ['guild-100'];
    config.allowedChannelIds = ['channel-200'];
    config.allowedUserIds = ['user-alice'];

    const apiClient = createMockApiClient();
    const auth = createMockAuth();
    const client = { user: { id: 'bot-agent-coding' } };

    // 1. /code prompt start
    const startInteraction = {
      guildId: 'guild-100',
      channelId: 'channel-200',
      inGuild: () => true,
      botPermissions: true,
      user: { id: 'user-alice' },
      member: { roles: { cache: new Map() } },
      options: {
        getSubcommandGroup: () => 'prompt',
        getSubcommand: () => 'start',
        getString: () => null
      },
      reply: async (payload) => payload,
      deferReply: async () => {},
      editReply: async (payload) => ({ id: 'reply-start', content: payload.content })
    };

    const startRes = await executeSlashCommand(startInteraction);
    assert.match(startRes.content, /Multipart Specification Started/);

    // 2. Chunks collected from plain messages
    const chunkMsg1 = createMockDiscordMessage({
      content: 'Part 1: Initial requirements setup'
    });
    const chunkRes1 = await handleMessage(chunkMsg1, client, apiClient, defaultPersistence, auth);
    assert.equal(chunkRes1.chunkAdded, true);

    const chunkMsg2 = createMockDiscordMessage({
      content: 'Part 2: Security and performance constraints'
    });
    const chunkRes2 = await handleMessage(chunkMsg2, client, apiClient, defaultPersistence, auth);
    assert.equal(chunkRes2.chunkAdded, true);

    // 3. /code prompt submit
    let submittedPayload = null;
    const submitInteraction = {
      guildId: 'guild-100',
      channelId: 'channel-200',
      inGuild: () => true,
      botPermissions: true,
      user: { id: 'user-alice' },
      member: { roles: { cache: new Map() } },
      options: {
        getSubcommandGroup: () => 'prompt',
        getSubcommand: () => 'submit'
      },
      reply: async (payload) => payload,
      deferReply: async () => {},
      editReply: async (payload) => {
        submittedPayload = payload;
        return { id: 'msg-submit-card', content: payload.content, components: payload.components };
      }
    };

    await executeSlashCommand(submitInteraction);
    assert.ok(submittedPayload);
    assert.match(submittedPayload.content, /Specification Received/);

    const sub = defaultPersistence.getSubmissionByMessageId('msg-submit-card');
    assert.ok(sub);
    assert.equal(sub.input_method, 'multipart_prompt');
    assert.equal(sub.metadata.totalChunks, 2);
  } finally {
    config.allowedGuildIds = prevGuilds;
    config.allowedChannelIds = prevChannels;
    config.allowedUserIds = prevUsers;
  }
});

test('5. Multipart prompt cancellation aborts collection cleanly', async () => {
  const prevGuilds = config.allowedGuildIds;
  const prevChannels = config.allowedChannelIds;
  const prevUsers = config.allowedUserIds;

  try {
    config.allowedGuildIds = ['guild-100'];
    config.allowedChannelIds = ['channel-200'];
    config.allowedUserIds = ['user-alice'];

    const mpId = randomUUID();
    defaultPersistence.startMultipartPrompt({
      id: mpId,
      guildId: 'guild-100',
      channelId: 'channel-200',
      userId: 'user-alice'
    });

    const cancelInteraction = {
      guildId: 'guild-100',
      channelId: 'channel-200',
      inGuild: () => true,
      botPermissions: true,
      user: { id: 'user-alice' },
      member: { roles: { cache: new Map() } },
      options: {
        getSubcommandGroup: () => 'prompt',
        getSubcommand: () => 'cancel'
      },
      reply: async (payload) => payload,
      deferReply: async () => {},
      editReply: async (payload) => payload
    };

    const res = await executeSlashCommand(cancelInteraction);
    assert.match(res.content, /cancelled/i);

    const active = defaultPersistence.getActiveMultipartPrompt({
      guildId: 'guild-100',
      channelId: 'channel-200',
      userId: 'user-alice'
    });
    assert.equal(active, undefined);
  } finally {
    config.allowedGuildIds = prevGuilds;
    config.allowedChannelIds = prevChannels;
    config.allowedUserIds = prevUsers;
  }
});

test('6. Multipart prompt restart survival: chunks and active collection persist across db reopen', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discord-bridge-test-'));
  const dbPath = join(tempDir, 'bridge.db');

  let store = new PersistenceStore(dbPath);
  const mpId = randomUUID();
  store.startMultipartPrompt({
    id: mpId,
    guildId: 'guild-100',
    channelId: 'channel-200',
    userId: 'user-bob'
  });
  store.addMultipartChunk({
    id: randomUUID(),
    multipartPromptId: mpId,
    chunkIndex: 0,
    content: 'First persistent chunk'
  });
  store.close();

  // Re-open persistence (simulating restart)
  store = new PersistenceStore(dbPath);
  store.reconcileRunningMessages();

  const active = store.getActiveMultipartPrompt({
    guildId: 'guild-100',
    channelId: 'channel-200',
    userId: 'user-bob'
  });
  assert.ok(active);
  assert.equal(active.id, mpId);
  assert.equal(active.total_chunks, 1);

  const chunks = store.getMultipartChunks(mpId);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content, 'First persistent chunk');

  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('7. Attachment validation: .txt format accepted', async () => {
  mockFetch(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => Buffer.from('Valid text spec content', 'utf8')
  }));

  try {
    const res = await downloadAndValidateAttachment({
      name: 'spec.txt',
      size: 24,
      url: 'https://cdn.discordapp.com/attachments/1/spec.txt'
    });
    assert.equal(res.filename, 'spec.txt');
    assert.equal(res.content, 'Valid text spec content');
  } finally {
    restoreFetch();
  }
});

test('8. Attachment validation: .md format accepted', async () => {
  mockFetch(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => Buffer.from('# Markdown Spec\n- Item 1\n- Item 2', 'utf8')
  }));

  try {
    const res = await downloadAndValidateAttachment({
      name: 'spec.md',
      size: 32,
      url: 'https://cdn.discordapp.com/attachments/1/spec.md'
    });
    assert.equal(res.filename, 'spec.md');
    assert.match(res.content, /# Markdown Spec/);
  } finally {
    restoreFetch();
  }
});

test('9. Attachment validation: non-.txt/.md extensions rejected', async () => {
  await assert.rejects(
    downloadAndValidateAttachment({
      name: 'payload.exe',
      size: 100,
      url: 'https://cdn.discordapp.com/attachments/1/payload.exe'
    }),
    /Only \.txt and \.md UTF-8 specification attachments are supported/
  );

  await assert.rejects(
    downloadAndValidateAttachment({
      name: 'script.py',
      size: 100,
      url: 'https://cdn.discordapp.com/attachments/1/script.py'
    }),
    /Only \.txt and \.md UTF-8 specification attachments are supported/
  );
});

test('10. Attachment validation: file exceeding MAX_ATTACHMENT_BYTES rejected', async () => {
  await assert.rejects(
    downloadAndValidateAttachment({
      name: 'huge.txt',
      size: 300000, // > 262144
      url: 'https://cdn.discordapp.com/attachments/1/huge.txt'
    }, { maxBytes: 262144 }),
    /File too large/
  );
});

test('11. Attachment validation: empty file (0 bytes) rejected', async () => {
  mockFetch(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => Buffer.alloc(0)
  }));

  try {
    await assert.rejects(
      downloadAndValidateAttachment({
        name: 'empty.txt',
        size: 0,
        url: 'https://cdn.discordapp.com/attachments/1/empty.txt'
      }),
      /Attachment is empty/
    );
  } finally {
    restoreFetch();
  }
});

test('12. Attachment validation: binary null byte (0x00) rejected', async () => {
  mockFetch(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f])
  }));

  try {
    await assert.rejects(
      downloadAndValidateAttachment({
        name: 'binary.txt',
        size: 5,
        url: 'https://cdn.discordapp.com/attachments/1/binary.txt'
      }),
      /Attachment contains invalid binary or null bytes/
    );
  } finally {
    restoreFetch();
  }
});

test('13. Attachment validation: non-Discord CDN origins rejected', async () => {
  await assert.rejects(
    downloadAndValidateAttachment({
      name: 'spec.txt',
      size: 50,
      url: 'https://evil-host.com/spec.txt'
    }),
    /only Discord CDN origins/
  );

  await assert.rejects(
    downloadAndValidateAttachment({
      name: 'spec.txt',
      size: 50,
      url: 'http://169.254.169.254/latest/meta-data'
    }),
    /only Discord CDN origins/
  );
});

test('14. Attachment validation: media.discordapp.net CDN origin accepted', async () => {
  mockFetch(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => Buffer.from('Media CDN content', 'utf8')
  }));

  try {
    const res = await downloadAndValidateAttachment({
      name: 'notes.txt',
      size: 17,
      url: 'https://media.discordapp.net/attachments/2/notes.txt'
    });
    assert.equal(res.content, 'Media CDN content');
  } finally {
    restoreFetch();
  }
});

test('15. Attachment validation: download timeout enforced', async () => {
  mockFetch(async (url, opts) => {
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });

  try {
    await assert.rejects(
      downloadAndValidateAttachment({
        name: 'spec.txt',
        size: 50,
        url: 'https://cdn.discordapp.com/attachments/1/spec.txt'
      }, { timeoutMs: 30 }),
      /timed out/
    );
  } finally {
    restoreFetch();
  }
});

test('16. SHA-256 calculation matches exact content digest', () => {
  const content = 'Test specification for SHA-256 calculation verification';
  const expectedHash = createHash('sha256').update(content, 'utf8').digest('hex');

  const artifact = savePromptArtifact(content, 'test.txt');
  assert.equal(artifact.sha256, expectedHash);
  assert.equal(artifact.sizeBytes, Buffer.byteLength(content, 'utf8'));
});

test('17. Verbatim preservation: complete prompt preserved without truncation', () => {
  const longPrompt = 'A'.repeat(50000); // 50KB specification
  const artifact = savePromptArtifact(longPrompt, 'long-spec.txt');
  assert.equal(artifact.content, longPrompt);
  assert.equal(artifact.sizeBytes, 50000);
});

test('18. Prompt artifact storage: file created with restrictive 0600 permissions', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'artifact-perm-test-'));
  try {
    const saved = savePromptArtifact('Secure specification content', 'spec.txt', tempDir);
    const stats = statSync(saved.artifactPath);
    // 0o600: owner read + write, no permissions for group/others
    const mode = stats.mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('19. Prompt artifact directory: created with restrictive 0700 permissions', () => {
  const tempDir = join(tmpdir(), 'artifacts-dir-' + Date.now());
  try {
    ensureArtifactsDirectory(tempDir);
    const stats = statSync(tempDir);
    const mode = stats.mode & 0o777;
    assert.equal(mode, 0o700);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('20. Submission tracking: lifecycle records persisted in discord_submissions', () => {
  const persistence = new PersistenceStore(':memory:');
  const subId = randomUUID();

  persistence.saveSubmission({
    id: subId,
    guildId: 'guild-100',
    channelId: 'channel-200',
    userId: 'user-charlie',
    submissionType: 'attachment',
    inputMethod: 'mention_with_attachment',
    promptHash: 'abc123hash',
    promptLength: 1024,
    status: 'received'
  });

  let sub = persistence.getSubmission(subId);
  assert.equal(sub.status, 'received');

  persistence.updateSubmission(subId, { status: 'executing', executionId: 'exec-456' });
  sub = persistence.getSubmission(subId);
  assert.equal(sub.status, 'executing');
  assert.equal(sub.execution_id, 'exec-456');

  persistence.updateSubmission(subId, { status: 'completed' });
  sub = persistence.getSubmission(subId);
  assert.equal(sub.status, 'completed');
  persistence.close();
});

test('21. Acknowledgment card: formats Specification Received with [Execute] and [Cancel] buttons', () => {
  const submission = {
    id: 'sub-test-123',
    prompt_length: 4096,
    prompt_hash: 'abcdef0123456789abcdef0123456789',
    input_method: 'reply_with_attachment'
  };

  const card = formatSpecificationCard(submission, { filename: 'spec.md' });
  assert.match(card.content, /📋 Specification Received/);
  assert.match(card.content, /4096 bytes/);
  assert.match(card.content, /spec\.md/);
  assert.equal(card.components.length, 1);
  assert.equal(card.components[0].components.length, 2);
  assert.equal(card.components[0].components[0].data.label, 'Execute');
  assert.equal(card.components[0].components[1].data.label, 'Cancel');
});

test('22. Execution start card: formats Execution Started with target and submission ID', () => {
  const submission = {
    id: 'sub-start-789',
    execution_id: 'task-1001'
  };

  const card = formatExecutionStartedCard(submission, { projectSlug: 'backend-api' });
  assert.match(card.content, /🚀 Execution Started/);
  assert.match(card.content, /backend-api/);
  assert.match(card.content, /sub-start-789/);
});

test('23. Execution result card: formats final output cleanly', () => {
  const submission = { id: 'sub-res-1', execution_id: 'task-101' };
  const card = formatExecutionResultCard(submission, {
    status: 'completed',
    response: 'Task executed successfully with 0 errors.'
  });

  assert.match(card.content, /✅ Execution Completed/);
  assert.match(card.content, /Task executed successfully/);
});

test('24. Output <= 2000 chars: rendered inline in Discord card', () => {
  const submission = { id: 'sub-inline', execution_id: 'task-102' };
  const response = 'Summary output line\n'.repeat(20); // ~400 chars
  const card = formatExecutionResultCard(submission, { status: 'completed', response });

  assert.ok(card.content.length <= 2000);
  assert.equal(card.files, undefined);
  assert.match(card.content, /Summary output line/);
});

test('25. Output > 2000 chars: rendered as sanitized .txt attachment', () => {
  const submission = { id: 'sub-large', execution_id: 'task-103' };
  const response = 'Voluminous trace logs line '.repeat(150); // > 3500 chars
  const card = formatExecutionResultCard(submission, { status: 'completed', response });

  assert.ok(card.content.length <= 2000);
  assert.ok(card.files && card.files.length === 1);
  assert.match(card.files[0].name, /execution-sub-larg\.txt/);
});

test('26. Critical Ballo workspace check: blocks execution when project ballo points to codeorchestrator', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ballo-mismatch-test-'));
  try {
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });
    execSync('git remote add origin https://github.com/lukman-ss/codeorchestrator', { cwd: tempDir, stdio: 'pipe' });
    const balloProject = {
      id: 'a78db8a9-3134-4f5f-9719-ecd2fe16c9ec',
      name: 'ballo',
      slug: 'ballo',
      workspace_path: tempDir
    };

    const check = validateProjectWorkspace(balloProject);
    assert.equal(check.valid, false);
    assert.equal(check.mismatch, true);
    assert.match(check.error, /Repository mismatch detected: Project 'ballo'/);
    assert.match(check.error, /intended repository is 'https:\/\/github\.com\/lukman-ss\/ballo'/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('27. Critical Ballo workspace check: does NOT mutate or delete repository checkout on disk', () => {
  const workspacePath = process.env.WORKSPACE_ROOT ? join(process.env.WORKSPACE_ROOT, 'ballo') : join(process.env.HOME || '', 'workspace/ballo');
  assert.ok(existsSync(workspacePath), 'Workspace directory must remain present on disk');
  assert.ok(existsSync(join(workspacePath, '.git')), 'Git directory must remain intact');
});

test('28. /code project repair: updates expected repository in metadata with explicit confirmation', async () => {
  // Missing confirmation throws error
  assert.throws(
    () => repairProject('non-existent', { confirm: false }),
    /Explicit confirmation is required/
  );
});

test('29. Cross-user authorization: user B cannot execute or cancel user A specification', async () => {
  const subId = randomUUID();
  defaultPersistence.saveSubmission({
    id: subId,
    guildId: 'guild-100',
    channelId: 'channel-200',
    userId: 'user-alice',
    submissionType: 'attachment',
    inputMethod: 'mention_with_attachment',
    promptHash: 'hash-xyz',
    promptLength: 200,
    status: 'received'
  });

  let replied = null;
  const crossUserInteraction = {
    customId: `btn_sub_exec_${subId}`,
    userId: 'user-mallory',
    user: { id: 'user-mallory' },
    member: { roles: { cache: new Map() } },
    reply: async (payload) => { replied = payload; }
  };

  await handleButton(crossUserInteraction);
  assert.ok(replied);
  assert.match(replied.content, /Only the submitter or an administrator can execute/);

  // Status must remain received
  const sub = defaultPersistence.getSubmission(subId);
  assert.equal(sub.status, 'received');
});
