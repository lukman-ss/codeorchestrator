import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execute, handleButton } from '../src/commands/code.js';
import apiClient from '../src/api-client.js';
import config from '../src/config.js';
import { OrchestratorEventListener } from '../src/event-listener.js';
import { PersistenceStore } from '../src/persistence.js';
import { formatGitReviewCard, formatGitDecisionResultCard } from '../src/notifications.js';
import { handleMessage } from '../src/natural-chat.js';

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

test('5b. Button interaction: btn_git_pr_* calls decideApproval and shows PR success card', async () => {
  const origGet = apiClient.getApproval;
  const origDecide = apiClient.decideApproval;

  apiClient.getApproval = async () => ({
    id: 'app-btn-pr',
    repository_identity: 'github.com/myorg/repo',
    target_branch: 'main',
    status: 'pending'
  });

  apiClient.decideApproval = async (id, { decision }) => ({
    success: true,
    decision: 'create_pr',
    prUrl: 'https://github.com/myorg/repo/pull/42',
    prNumber: 42,
    branchName: 'orchestrator/feature-42',
    commitSha: '112233445566'
  });

  try {
    const interaction = createMockButtonInteraction({
      customId: 'btn_git_pr_app-btn-pr'
    });

    await handleButton(interaction);
    const replies = interaction.getReplies();
    assert.ok(replies.length > 0);
    const finalReply = replies[replies.length - 1];
    assert.ok(finalReply.content.includes('Pull Request Created Successfully'));
    assert.ok(finalReply.content.includes('#42'));
    assert.ok(finalReply.content.includes('https://github.com/myorg/repo/pull/42'));
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

test('8. Event listener tracks review card message IDs on approval.requested', async () => {
  const origGet = apiClient.getApproval;
  const origUpdate = apiClient.updateApprovalDiscordMessage;
  let updatedPayload = null;

  apiClient.getApproval = async () => ({
    id: 'app-track-1',
    task_id: 'task-track-1',
    repository_identity: 'org/repo',
    target_branch: 'main',
    status: 'pending',
    files_changed: ['main.go'],
    diff_summary: { added: 5, modified: 0, deleted: 0 },
    proposed_commit_message: 'feat: add main'
  });

  apiClient.updateApprovalDiscordMessage = async (approvalId, payload) => {
    updatedPayload = { approvalId, ...payload };
    return { id: approvalId, ...payload };
  };

  const sentMessages = [];
  const mockChannel = {
    send: async (msg) => {
      const sent = { id: 'msg-card-999', ...msg };
      sentMessages.push(sent);
      return sent;
    }
  };

  const mockDiscord = {
    channels: {
      fetch: async () => mockChannel
    }
  };

  const persistence = new PersistenceStore(':memory:');
  persistence.saveExecution({
    id: 'task-track-1',
    kind: 'task',
    guildId: 'guild-100',
    channelId: 'channel-200',
    messageId: 'msg-task-100',
    userId: 'user-300',
    status: 'running'
  });

  const listener = new OrchestratorEventListener(apiClient, persistence, mockDiscord, config);

  try {
    await listener.handleEvent({
      type: 'approval.requested',
      taskId: 'task-track-1',
      payload: {
        approvalId: 'app-track-1',
        taskId: 'task-track-1'
      }
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(updatedPayload?.approvalId, 'app-track-1');
    assert.equal(updatedPayload?.messageId, 'msg-card-999');

    // Persistence check
    const saved = persistence.getApprovalMessage('msg-card-999');
    assert.ok(saved);
    assert.equal(saved.approval_id, 'app-track-1');
    assert.equal(saved.task_id, 'task-track-1');

    const byApproval = persistence.getApprovalMessageByApprovalId('app-track-1');
    assert.equal(byApproval?.message_id, 'msg-card-999');

    const byTask = persistence.getApprovalMessageByTaskOrJob('task-track-1');
    assert.equal(byTask?.message_id, 'msg-card-999');
  } finally {
    apiClient.getApproval = origGet;
    apiClient.updateApprovalDiscordMessage = origUpdate;
    persistence.close();
  }
});

test('9. Replying to a task notification message renders the interactive Git review card with buttons', async () => {
  const origReview = apiClient.getTaskReview;
  const origGet = apiClient.getApproval;

  apiClient.getTaskReview = async () => ({
    review: { acceptance_status: 'PASS', security_status: 'PASS', git_status: 'AWAITING_APPROVAL' },
    approval: {
      id: 'app-reply-task-1',
      task_id: 'task-notif-1',
      repository_identity: 'github.com/myorg/ballo',
      target_branch: 'main',
      status: 'pending',
      files_changed: ['internal/app.go'],
      diff_summary: { added: 12, modified: 2, deleted: 0 },
      proposed_commit_message: 'feat: add internal app logic'
    }
  });

  const persistence = new PersistenceStore(':memory:');
  persistence.saveExecution({
    id: 'task-notif-1',
    kind: 'task',
    guildId: 'guild-100',
    channelId: 'channel-200',
    messageId: 'msg-task-notif-1',
    userId: 'user-300',
    status: 'awaiting_approval'
  });

  const authMock = {
    isGuildAllowed: () => true,
    isChannelAllowed: () => true,
    hasBotPermissions: () => true,
    isUserAllowed: () => ({ allowed: true }),
    isSessionAllowedForUser: () => true,
    isProjectAllowedForUser: () => true
  };

  const clientMock = {
    user: { id: 'bot-123' }
  };

  const replies = [];
  const replyMessage = {
    id: 'msg-user-reply-1',
    guildId: 'guild-100',
    channelId: 'channel-200',
    author: { id: 'user-300', bot: false },
    mentions: { users: new Map(), has: () => false },
    reference: { messageId: 'msg-task-notif-1' },
    referencedMessage: {
      id: 'msg-task-notif-1',
      author: { id: 'bot-123', bot: true }
    },
    content: 'push ke main',
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    }
  };

  try {
    await handleMessage(replyMessage, clientMock, apiClient, persistence, authMock);

    assert.equal(replies.length, 1);
    const card = replies[0];
    assert.doesNotMatch(card.content || '', /belongs to a task notification/);
    assert.match(card.content, /Completion Gates Review & Approval/);
    assert.match(card.content, /github\.com\/myorg\/ballo/);
    assert.ok(card.components && card.components.length > 0);
  } finally {
    apiClient.getTaskReview = origReview;
    apiClient.getApproval = origGet;
    persistence.close();
  }
});

test('10. Replying to an approval card message renders the interactive Git review card with buttons', async () => {
  const origGet = apiClient.getApproval;
  const origReview = apiClient.getTaskReview;

  apiClient.getApproval = async (id) => ({
    id: 'app-reply-card-1',
    task_id: 'task-notif-2',
    repository_identity: 'github.com/myorg/ballo',
    target_branch: 'main',
    status: 'pending',
    files_changed: ['internal/app.go'],
    diff_summary: { added: 12, modified: 2, deleted: 0 },
    proposed_commit_message: 'feat: add internal app logic'
  });

  apiClient.getTaskReview = async () => ({
    review: { acceptance_status: 'PASS', security_status: 'PASS', git_status: 'AWAITING_APPROVAL' },
    approval: {
      id: 'app-reply-card-1',
      task_id: 'task-notif-2',
      repository_identity: 'github.com/myorg/ballo',
      target_branch: 'main',
      status: 'pending'
    }
  });

  const persistence = new PersistenceStore(':memory:');
  persistence.saveApprovalMessage({
    id: 'rec-1',
    approvalId: 'app-reply-card-1',
    taskId: 'task-notif-2',
    guildId: 'guild-100',
    channelId: 'channel-200',
    messageId: 'msg-approval-card-1'
  });

  const authMock = {
    isGuildAllowed: () => true,
    isChannelAllowed: () => true,
    hasBotPermissions: () => true,
    isUserAllowed: () => ({ allowed: true }),
    isSessionAllowedForUser: () => true,
    isProjectAllowedForUser: () => true
  };

  const clientMock = {
    user: { id: 'bot-123' }
  };

  const replies = [];
  const replyMessage = {
    id: 'msg-user-reply-2',
    guildId: 'guild-100',
    channelId: 'channel-200',
    author: { id: 'user-300', bot: false },
    mentions: { users: new Map(), has: () => false },
    reference: { messageId: 'msg-approval-card-1' },
    referencedMessage: {
      id: 'msg-approval-card-1',
      author: { id: 'bot-123', bot: true }
    },
    content: 'commit dan push',
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    }
  };

  try {
    await handleMessage(replyMessage, clientMock, apiClient, persistence, authMock);

    assert.equal(replies.length, 1);
    const card = replies[0];
    assert.doesNotMatch(card.content || '', /belongs to a/);
    assert.match(card.content, /Completion Gates Review & Approval/);
    assert.ok(card.components && card.components.length > 0);
  } finally {
    apiClient.getApproval = origGet;
    apiClient.getTaskReview = origReview;
    persistence.close();
  }
});

test('11. Natural Chat: CONFIGURE_GIT_AND_RESUME_TASK routed via Tier 1 (explicit task ID)', async () => {
  const origGet = apiClient.getTask;
  const origRecover = apiClient.recoverTask;
  const origConfig = apiClient.configureGitRemote;
  const origReview = apiClient.getTaskReview;

  let recoveredTaskId = null;
  let configuredRemote = null;

  apiClient.getTask = async (id) => ({
    id,
    project_id: 'proj-123',
    project_slug: 'ballo-todo',
    status: 'blocked',
    workflow_status: 'blocked',
    execution_status: 'completed',
    exit_code: 0
  });

  apiClient.configureGitRemote = async (projId, { repoUrl }) => {
    configuredRemote = { projId, repoUrl };
    return { configured: true, remoteUrl: repoUrl };
  };

  apiClient.recoverTask = async (id, opts) => {
    recoveredTaskId = id;
    return {
      taskId: id,
      workflow_status: 'awaiting_approval',
      project: { slug: 'ballo-todo' },
      workflowResult: {
        status: 'awaiting_approval',
        approvalRequest: {
          id: 'app-tier1',
          repository_identity: opts.remoteUrl,
          target_branch: 'main',
          status: 'pending'
        },
        gitReview: { taskFiles: ['main.go'] }
      }
    };
  };

  apiClient.getTaskReview = async () => ({
    approval: { id: 'app-tier1', repository_identity: 'git@github.com:lukman-ss/ballo-todo.git', target_branch: 'main', status: 'pending' },
    review: { taskFiles: ['main.go'] }
  });

  const persistence = new PersistenceStore(':memory:');
  const authMock = {
    isGuildAllowed: () => true,
    isChannelAllowed: () => true,
    hasBotPermissions: () => true,
    isUserAllowed: () => ({ allowed: true })
  };
  const clientMock = { user: { id: 'bot-123' } };

  const replies = [];
  const msg = {
    id: 'msg-tier1',
    guildId: 'guild-100',
    channelId: 'channel-200',
    author: { id: 'user-300', bot: false },
    mentions: { users: new Map([['bot-123', true]]), has: (id) => id === 'bot-123' },
    content: '<@bot-123> configure git remote git@github.com:lukman-ss/ballo-todo.git and resume task 11111111-2222-3333-4444-555555555555',
    reply: async (payload) => { replies.push(payload); return payload; }
  };

  try {
    await handleMessage(msg, clientMock, apiClient, persistence, authMock);
    assert.equal(replies.length, 1);
    assert.equal(recoveredTaskId, '11111111-2222-3333-4444-555555555555');
    assert.equal(configuredRemote?.repoUrl, 'git@github.com:lukman-ss/ballo-todo.git');
    assert.match(replies[0].content, /Resumed & Progressed to Gate 3/);
    assert.ok(replies[0].components?.length > 0);
  } finally {
    apiClient.getTask = origGet;
    apiClient.recoverTask = origRecover;
    apiClient.configureGitRemote = origConfig;
    apiClient.getTaskReview = origReview;
    persistence.close();
  }
});

test('12. Natural Chat: CONFIGURE_GIT_AND_RESUME_TASK routed via Tier 2 (referenced message)', async () => {
  const origGet = apiClient.getTask;
  const origRecover = apiClient.recoverTask;
  const origReview = apiClient.getTaskReview;

  let recoveredTaskId = null;

  apiClient.getTask = async (id) => ({
    id,
    project_id: 'proj-456',
    project_slug: 'test-proj',
    status: 'blocked',
    workflow_status: 'blocked',
    execution_status: 'completed',
    exit_code: 0
  });

  apiClient.recoverTask = async (id) => {
    recoveredTaskId = id;
    return {
      taskId: id,
      workflow_status: 'awaiting_approval',
      workflowResult: {
        status: 'awaiting_approval',
        approvalRequest: { id: 'app-tier2', repository_identity: 'test/repo', target_branch: 'main', status: 'pending' },
        gitReview: { taskFiles: [] }
      }
    };
  };

  apiClient.getTaskReview = async () => ({
    approval: { id: 'app-tier2', repository_identity: 'test/repo', target_branch: 'main', status: 'pending' },
    review: { taskFiles: [] }
  });

  const persistence = new PersistenceStore(':memory:');
  persistence.saveExecution({
    id: '22222222-3333-4444-5555-666666666666',
    kind: 'task',
    guildId: 'guild-100',
    channelId: 'channel-200',
    messageId: 'msg-blocked-card-1',
    userId: 'user-300',
    status: 'blocked'
  });

  const authMock = {
    isGuildAllowed: () => true,
    isChannelAllowed: () => true,
    hasBotPermissions: () => true,
    isUserAllowed: () => ({ allowed: true })
  };
  const clientMock = { user: { id: 'bot-123' } };

  const replies = [];
  const msg = {
    id: 'msg-tier2',
    guildId: 'guild-100',
    channelId: 'channel-200',
    author: { id: 'user-300', bot: false },
    mentions: { users: new Map(), has: () => false },
    reference: { messageId: 'msg-blocked-card-1' },
    referencedMessage: { id: 'msg-blocked-card-1', author: { id: 'bot-123', bot: true } },
    content: 'resume',
    reply: async (payload) => { replies.push(payload); return payload; }
  };

  try {
    await handleMessage(msg, clientMock, apiClient, persistence, authMock);
    assert.equal(replies.length, 1);
    assert.equal(recoveredTaskId, '22222222-3333-4444-5555-666666666666');
    assert.match(replies[0].content, /Resumed & Progressed to Gate 3/);
  } finally {
    apiClient.getTask = origGet;
    apiClient.recoverTask = origRecover;
    apiClient.getTaskReview = origReview;
    persistence.close();
  }
});

test('13. Natural Chat: CONFIGURE_GIT_AND_RESUME_TASK routed via Tier 4 (explicit project unambiguous)', async () => {
  const origFind = apiClient.findRecoverableTask;
  const origRecover = apiClient.recoverTask;
  const origResolve = apiClient.resolveProject;
  const origReview = apiClient.getTaskReview;

  let recoveredTaskId = null;

  apiClient.resolveProject = async (slug) => ({ id: '77777777-8888-9999-aaaa-bbbbbbbbbbbb', slug });
  apiClient.findRecoverableTask = async () => ({
    id: '33333333-4444-5555-6666-777777777777',
    project_id: '77777777-8888-9999-aaaa-bbbbbbbbbbbb',
    project_slug: 'my-proj',
    status: 'blocked',
    workflow_status: 'blocked',
    execution_status: 'completed',
    exit_code: 0
  });

  apiClient.recoverTask = async (id) => {
    recoveredTaskId = id;
    return {
      taskId: id,
      workflow_status: 'awaiting_approval',
      workflowResult: {
        status: 'awaiting_approval',
        approvalRequest: { id: 'app-tier4', repository_identity: 'org/repo', target_branch: 'main', status: 'pending' },
        gitReview: { taskFiles: [] }
      }
    };
  };

  apiClient.getTaskReview = async () => ({
    approval: { id: 'app-tier4', repository_identity: 'org/repo', target_branch: 'main', status: 'pending' },
    review: { taskFiles: [] }
  });

  const persistence = new PersistenceStore(':memory:');
  const authMock = {
    isGuildAllowed: () => true,
    isChannelAllowed: () => true,
    hasBotPermissions: () => true,
    isUserAllowed: () => ({ allowed: true })
  };
  const clientMock = { user: { id: 'bot-123' } };

  const replies = [];
  const msg = {
    id: 'msg-tier4',
    guildId: 'guild-100',
    channelId: 'channel-200',
    author: { id: 'user-300', bot: false },
    mentions: { users: new Map([['bot-123', true]]), has: (id) => id === 'bot-123' },
    content: '<@bot-123> project: my-proj\nresume',
    reply: async (payload) => { replies.push(payload); return payload; }
  };

  try {
    await handleMessage(msg, clientMock, apiClient, persistence, authMock);
    assert.equal(replies.length, 1);
    assert.equal(recoveredTaskId, '33333333-4444-5555-6666-777777777777');
    assert.match(replies[0].content, /Resumed & Progressed to Gate 3/);
  } finally {
    apiClient.findRecoverableTask = origFind;
    apiClient.recoverTask = origRecover;
    apiClient.resolveProject = origResolve;
    apiClient.getTaskReview = origReview;
    persistence.close();
  }
});

test('14. Natural Chat: Ambiguous project resolution rejects and lists candidate tasks', async () => {
  const origFind = apiClient.findRecoverableTask;
  const origResolve = apiClient.resolveProject;

  apiClient.resolveProject = async (slug) => ({ id: '88888888-9999-aaaa-bbbb-cccccccccccc', slug });
  apiClient.findRecoverableTask = async () => {
    const err = new Error("Multiple recoverable tasks found for project 'proj-ambig'. Explicit task ID required.");
    err.ambiguous = true;
    err.candidates = ['task-c1', 'task-c2'];
    throw err;
  };

  const persistence = new PersistenceStore(':memory:');
  const authMock = {
    isGuildAllowed: () => true,
    isChannelAllowed: () => true,
    hasBotPermissions: () => true,
    isUserAllowed: () => ({ allowed: true })
  };
  const clientMock = { user: { id: 'bot-123' } };

  const replies = [];
  const msg = {
    id: 'msg-ambig',
    guildId: 'guild-100',
    channelId: 'channel-200',
    author: { id: 'user-300', bot: false },
    mentions: { users: new Map([['bot-123', true]]), has: (id) => id === 'bot-123' },
    content: '<@bot-123> project: ambig-proj\nresume',
    reply: async (payload) => { replies.push(payload); return payload; }
  };

  try {
    await handleMessage(msg, clientMock, apiClient, persistence, authMock);
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Multiple Recoverable Tasks Found/);
    assert.match(replies[0].content, /task-c1/);
    assert.match(replies[0].content, /task-c2/);
  } finally {
    apiClient.findRecoverableTask = origFind;
    apiClient.resolveProject = origResolve;
    persistence.close();
  }
});

test('15. Natural Chat: Ballo mismatch blocks codeorchestrator remote on ballo project', async () => {
  const origResolve = apiClient.resolveProject;
  const origGet = apiClient.getTask;

  apiClient.resolveProject = async (slug) => ({ id: 'proj-ballo', slug });
  apiClient.getTask = async (id) => ({
    id,
    project_id: 'proj-ballo',
    project_slug: 'ballo-todo',
    status: 'blocked',
    workflow_status: 'blocked',
    execution_status: 'completed',
    exit_code: 0
  });

  const persistence = new PersistenceStore(':memory:');
  const authMock = {
    isGuildAllowed: () => true,
    isChannelAllowed: () => true,
    hasBotPermissions: () => true,
    isUserAllowed: () => ({ allowed: true })
  };
  const clientMock = { user: { id: 'bot-123' } };

  const replies = [];
  const msg = {
    id: 'msg-mismatch',
    guildId: 'guild-100',
    channelId: 'channel-200',
    author: { id: 'user-300', bot: false },
    mentions: { users: new Map([['bot-123', true]]), has: (id) => id === 'bot-123' },
    content: '<@bot-123> configure git remote git@github.com:lukman-ss/codeorchestrator.git and resume task 44444444-5555-6666-7777-888888888888',
    reply: async (payload) => { replies.push(payload); return payload; }
  };

  try {
    await handleMessage(msg, clientMock, apiClient, persistence, authMock);
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Repository Mismatch/);
    assert.match(replies[0].content, /Cannot configure codeorchestrator repository/);
  } finally {
    apiClient.resolveProject = origResolve;
    apiClient.getTask = origGet;
    persistence.close();
  }
});
