import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execute, handleButton } from '../src/commands/code.js';
import apiClient from '../src/api-client.js';
import config from '../src/config.js';
import { OrchestratorEventListener } from '../src/event-listener.js';
import { PersistenceStore } from '../src/persistence.js';
import { formatGitReviewCard, formatGitDecisionResultCard } from '../src/notifications.js';

beforeEach(() => {
  config.allowedGuildIds = ['*'];
  config.allowedChannelIds = ['*'];
  config.allowedUserIds = ['*'];
});

function createMockInteraction({
  subcommand = 'approvals',
  guildId = 'guild-100',
  channelId = 'channel-200',
  userId = 'user-300',
  memberRoles = ['role-admin'],
  options = {}
} = {}) {
  const replies = [];
  let isDeferred = false;
  let updatedMessage = null;

  return {
    guildId,
    channelId,
    user: { id: userId, tag: `User#${userId}` },
    userId,
    member: {
      roles: {
        cache: new Map(memberRoles.map(r => [r, { id: r }]))
      }
    },
    inGuild: () => true,
    replied: false,
    deferred: isDeferred,
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null
    },
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    deferReply: async () => {
      isDeferred = true;
      return true;
    },
    editReply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    update: async (payload) => {
      updatedMessage = payload;
      replies.push(payload);
      return payload;
    },
    getReplies: () => replies,
    getUpdated: () => updatedMessage
  };
}

function createMockButtonInteraction({
  customId,
  guildId = 'guild-100',
  channelId = 'channel-200',
  userId = 'user-300',
  memberRoles = ['role-admin']
} = {}) {
  const replies = [];
  let updated = null;
  return {
    customId,
    guildId,
    channelId,
    user: { id: userId, tag: `User#${userId}` },
    userId,
    member: {
      roles: {
        cache: new Map(memberRoles.map(r => [r, { id: r }]))
      }
    },
    inGuild: () => true,
    update: async (payload) => {
      updated = payload;
      replies.push(payload);
      return payload;
    },
    editReply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    getReplies: () => replies,
    getUpdated: () => updated
  };
}

test('1. /code approvals returns list of pending approvals', async () => {
  const origList = apiClient.listPendingApprovals;
  apiClient.listPendingApprovals = async () => [
    {
      id: 'app-test-123',
      task_id: 'task-456',
      repository_identity: 'org/repo',
      target_branch: 'main',
      files_changed_json: '["src/index.js"]',
      diff_summary_json: '{"added":1,"modified":0,"deleted":0}',
      created_at: new Date().toISOString()
    }
  ];

  try {
    const interaction = createMockInteraction({ subcommand: 'approvals' });
    await execute(interaction);
    const replies = interaction.getReplies();
    assert.ok(replies.length > 0);
    const text = replies[0].content;
    assert.ok(text.includes('Pending Git Approvals'));
    assert.ok(text.includes('app-test-123'));
    assert.ok(text.includes('org/repo'));
  } finally {
    apiClient.listPendingApprovals = origList;
  }
});

test('2. /code approvals handles empty pending approvals cleanly', async () => {
  const origList = apiClient.listPendingApprovals;
  apiClient.listPendingApprovals = async () => [];

  try {
    const interaction = createMockInteraction({ subcommand: 'approvals' });
    await execute(interaction);
    const replies = interaction.getReplies();
    assert.ok(replies.length > 0);
    assert.ok(replies[0].content.includes('No pending Git approvals'));
  } finally {
    apiClient.listPendingApprovals = origList;
  }
});

test('3. /code review renders 3-gate card and decision buttons', async () => {
  const origGet = apiClient.getApproval;
  apiClient.getApproval = async () => ({
    id: 'app-rev-1',
    task_id: 'task-789',
    repository_identity: 'org/my-project',
    target_branch: 'main',
    status: 'pending',
    files_changed: ['main.go'],
    diff_summary: { added: 10, modified: 0, deleted: 0 },
    proposed_commit_message: 'feat: add main function'
  });

  try {
    const interaction = createMockInteraction({
      subcommand: 'review',
      options: { id: 'app-rev-1' }
    });
    await execute(interaction);
    const replies = interaction.getReplies();
    assert.ok(replies.length > 0);
    const msg = replies[0];
    assert.ok(msg.content.includes('Completion Gates Review & Approval'));
    assert.ok(msg.content.includes('Gate 1 (Verification): ✅ **PASS**'));
    assert.ok(msg.content.includes('Gate 2 (Security Audit): ✅ **PASS**'));
    assert.ok(msg.content.includes('Gate 3 (Git Review): ⏳ **AWAITING DECISION**'));
    assert.ok(msg.components && msg.components.length > 0);
  } finally {
    apiClient.getApproval = origGet;
  }
});

test('4. /code approve submits decision to API', async () => {
  const origGet = apiClient.getApproval;
  const origDecide = apiClient.decideApproval;

  apiClient.getApproval = async () => ({
    id: 'app-approve-1',
    repository_identity: 'org/repo',
    target_branch: 'main',
    status: 'pending'
  });

  apiClient.decideApproval = async (id, { decision }) => ({
    success: true,
    decision,
    commitSha: decision === 'push' ? 'abc1234' : null
  });

  try {
    const interaction = createMockInteraction({
      subcommand: 'approve',
      options: { id: 'app-approve-1', decision: 'keep_local' }
    });
    await execute(interaction);
    const replies = interaction.getReplies();
    assert.ok(replies.length > 0);
    assert.ok(replies[0].content.includes('Local Changes Preserved'));
  } finally {
    apiClient.getApproval = origGet;
    apiClient.decideApproval = origDecide;
  }
});

test('5. Button interaction: btn_git_push_* calls decideApproval and shows push success card', async () => {
  const origGet = apiClient.getApproval;
  const origDecide = apiClient.decideApproval;

  apiClient.getApproval = async () => ({
    id: 'app-btn-push',
    repository_identity: 'github.com/myorg/repo',
    target_branch: 'main',
    status: 'pending'
  });

  apiClient.decideApproval = async (id, { decision }) => ({
    success: true,
    decision: 'push',
    commitSha: '9876543210abcdef'
  });

  try {
    const interaction = createMockButtonInteraction({
      customId: 'btn_git_push_app-btn-push'
    });

    await handleButton(interaction);
    const replies = interaction.getReplies();
    assert.ok(replies.length > 0);
    const finalReply = replies[replies.length - 1];
    assert.ok(finalReply.content.includes('Pushed to GitHub Successfully'));
    assert.ok(finalReply.content.includes('9876543210abcdef'));
  } finally {
    apiClient.getApproval = origGet;
    apiClient.decideApproval = origDecide;
  }
});

test('6. Button interaction: btn_git_keeplocal_* preserves workspace changes locally', async () => {
  const origGet = apiClient.getApproval;
  const origDecide = apiClient.decideApproval;

  apiClient.getApproval = async () => ({
    id: 'app-btn-keep',
    repository_identity: 'github.com/myorg/repo',
    target_branch: 'main',
    status: 'pending'
  });

  apiClient.decideApproval = async (id, { decision }) => ({
    success: true,
    decision: 'keep_local',
    localPreserved: true
  });

  try {
    const interaction = createMockButtonInteraction({
      customId: 'btn_git_keeplocal_app-btn-keep'
    });

    await handleButton(interaction);
    const replies = interaction.getReplies();
    assert.ok(replies.length > 0);
    const finalReply = replies[replies.length - 1];
    assert.ok(finalReply.content.includes('Local Changes Preserved'));
  } finally {
    apiClient.getApproval = origGet;
    apiClient.decideApproval = origDecide;
  }
});

test('7. Event listener handles approval.requested by fetching approval and sending review card', async () => {
  const origGet = apiClient.getApproval;
  apiClient.getApproval = async () => ({
    id: 'app-event-1',
    task_id: 'task-ev-1',
    repository_identity: 'org/repo',
    target_branch: 'main',
    files_changed: ['file1.js'],
    diff_summary: { added: 1, modified: 0, deleted: 0 },
    proposed_commit_message: 'feat: event card'
  });

  const sentMessages = [];
  const mockChannel = {
    send: async (msg) => {
      sentMessages.push(msg);
      return { id: 'msg-ev-' + Date.now() };
    }
  };

  const mockDiscord = {
    channels: {
      fetch: async () => mockChannel
    }
  };

  const persistence = new PersistenceStore(':memory:');
  persistence.saveExecution({
    id: 'task-ev-1',
    kind: 'task',
    guildId: 'guild-100',
    channelId: 'channel-200',
    messageId: 'msg-exec-100',
    userId: 'user-300',
    status: 'running'
  });

  const listener = new OrchestratorEventListener(apiClient, persistence, mockDiscord, config);

  try {
    await listener.handleEvent({
      type: 'approval.requested',
      taskId: 'task-ev-1',
      payload: {
        approvalId: 'app-event-1',
        taskId: 'task-ev-1'
      }
    });

    assert.ok(sentMessages.length > 0);
    const card = sentMessages[0];
    assert.ok(card.content.includes('Completion Gates Review & Approval'));
    assert.ok(card.components && card.components.length > 0);
  } finally {
    apiClient.getApproval = origGet;
    persistence.close();
  }
});
