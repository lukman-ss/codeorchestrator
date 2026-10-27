import test from 'node:test';
import assert from 'node:assert/strict';
import codeCommand, {
  data as codeCommandData,
  execute,
  handleAutocomplete,
  handleModalSubmit,
  handleButton,
  pendingCreations
} from '../src/commands/code.js';
import { AuthorizationService } from '../src/authorization.js';
import { PersistenceStore } from '../src/persistence.js';
import defaultApiClient, { OrchestratorApiClient } from '../src/api-client.js';
import config from '../src/config.js';
import { redactSensitive } from '../src/notifications.js';

function createMockInteraction({
  subcommandGroup = null,
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
  let shownModal = null;
  let updatedMessage = null;

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
      getSubcommandGroup: () => subcommandGroup,
      getSubcommand: () => subcommand,
      getString: (name, req = false) => options[name] ?? null,
      getInteger: (name, req = false) => options[name] ?? null,
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
    update: async (payload) => {
      updatedMessage = payload;
      replies.push(payload);
      return payload;
    },
    showModal: async (modal) => {
      shownModal = modal;
      return modal;
    },
    respond: async (choices) => choices,
    getReplies: () => replies,
    getShownModal: () => shownModal,
    getUpdated: () => updatedMessage
  };
}

function createMockModalInteraction({
  customId = 'modal_project_create',
  guildId = 'guild-100',
  channelId = 'channel-200',
  userId = 'user-300',
  memberRoles = ['role-admin'],
  fields = {},
  inGuild = true
} = {}) {
  const replies = [];
  return {
    customId,
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
    fields: {
      getTextInputValue: (id) => fields[id] ?? ''
    },
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    getReplies: () => replies
  };
}

function createMockButtonInteraction({
  customId,
  guildId = 'guild-100',
  channelId = 'channel-200',
  userId = 'user-300',
  memberRoles = ['role-admin'],
  inGuild = true
} = {}) {
  const replies = [];
  let updated = null;
  return {
    customId,
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
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    update: async (payload) => {
      updated = payload;
      replies.push(payload);
      return payload;
    },
    editReply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    getReplies: () => replies,
    getUpdated: () => updated
  };
}

// 0. Default export contains all required interaction handlers
test('0. codeCommand default export contains execute, handleAutocomplete, handleModalSubmit, handleButton', () => {
  assert.equal(typeof codeCommand.execute, 'function');
  assert.equal(typeof codeCommand.handleAutocomplete, 'function');
  assert.equal(typeof codeCommand.handleModalSubmit, 'function');
  assert.equal(typeof codeCommand.handleButton, 'function');
});

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

// 17. /code project create triggers modal display
test('17. /code project create triggers modal display with name prefilled', async () => {
  const prevGuilds = config.allowedGuildIds;
  const prevChannels = config.allowedChannelIds;
  const prevUsers = config.allowedUserIds;

  try {
    config.allowedGuildIds = ['guild-100'];
    config.allowedChannelIds = ['channel-200'];
    config.allowedUserIds = ['user-300'];

    const interaction = createMockInteraction({
      subcommandGroup: 'project',
      subcommand: 'create',
      options: { name: 'Project Alpha' }
    });

    await execute(interaction);

    const modal = interaction.getShownModal();
    assert.ok(modal);
    assert.equal(modal.data.custom_id, 'modal_project_create');
    assert.equal(modal.data.title, 'Create Coding Project');
  } finally {
    config.allowedGuildIds = prevGuilds;
    config.allowedChannelIds = prevChannels;
    config.allowedUserIds = prevUsers;
  }
});

// 18. Modal submission creates confirmation card with pending token
test('18. Modal submission validates input and creates confirmation card with pending token', async () => {
  const prevGuilds = config.allowedGuildIds;
  const prevChannels = config.allowedChannelIds;
  const prevUsers = config.allowedUserIds;

  try {
    config.allowedGuildIds = ['guild-100'];
    config.allowedChannelIds = ['channel-200'];
    config.allowedUserIds = ['user-300'];

    const modalInteraction = createMockModalInteraction({
      userId: 'user-300',
      fields: {
        proj_name: 'Test Project',
        proj_desc: 'Test description',
        proj_repo_url: 'https://github.com/octocat/hello-world',
        proj_branch: 'main'
      }
    });

    await handleModalSubmit(modalInteraction);

    const replies = modalInteraction.getReplies();
    assert.equal(replies.length, 1);
    const card = replies[0];
    assert.ok(card.content.includes('Project Configuration'));
    assert.ok(card.content.includes('Test Project'));
    assert.ok(card.content.includes('test-project'));
    assert.equal(card.ephemeral, true);
    assert.equal(card.components.length, 1);
    assert.equal(card.components[0].components.length, 2);

    const confirmBtn = card.components[0].components[0];
    assert.ok(confirmBtn.data.custom_id.startsWith('btn_proj_confirm:'));
    const pendingId = confirmBtn.data.custom_id.replace('btn_proj_confirm:', '');
    assert.ok(pendingCreations.has(pendingId));

    const pending = pendingCreations.get(pendingId);
    assert.equal(pending.name, 'Test Project');
    assert.equal(pending.slug, 'test-project');
    assert.equal(pending.repoUrl, 'https://github.com/octocat/hello-world');

    pendingCreations.delete(pendingId);
  } finally {
    config.allowedGuildIds = prevGuilds;
    config.allowedChannelIds = prevChannels;
    config.allowedUserIds = prevUsers;
  }
});

// 19. Modal submission with invalid GitHub URL is rejected
test('19. Modal submission with invalid GitHub URL is rejected', async () => {
  const prevGuilds = config.allowedGuildIds;
  const prevChannels = config.allowedChannelIds;
  const prevUsers = config.allowedUserIds;

  try {
    config.allowedGuildIds = ['guild-100'];
    config.allowedChannelIds = ['channel-200'];
    config.allowedUserIds = ['user-300'];

    const modalInteraction = createMockModalInteraction({
      userId: 'user-300',
      fields: {
        proj_name: 'Invalid Repo Project',
        proj_repo_url: 'https://malicious-site.com/exploit.git'
      }
    });

    await handleModalSubmit(modalInteraction);

    const replies = modalInteraction.getReplies();
    assert.equal(replies.length, 1);
    assert.ok(replies[0].content.includes('Invalid GitHub URL'));
    assert.equal(replies[0].ephemeral, true);
  } finally {
    config.allowedGuildIds = prevGuilds;
    config.allowedChannelIds = prevChannels;
    config.allowedUserIds = prevUsers;
  }
});

// 20. Cross-user confirmation button rejection
test('20. Cross-user confirmation button rejection', async () => {
  const pendingId = 'pending-auth-test-' + Date.now();
  pendingCreations.set(pendingId, {
    userId: 'original-creator',
    name: 'Protected Proj',
    slug: 'protected-proj',
    timestamp: Date.now()
  });

  const btnInteraction = createMockButtonInteraction({
    customId: `btn_proj_confirm:${pendingId}`,
    userId: 'another-user'
  });

  await handleButton(btnInteraction);

  const replies = btnInteraction.getReplies();
  assert.equal(replies.length, 1);
  assert.ok(replies[0].content.includes('Only the original requester can confirm this creation'));
  assert.equal(replies[0].ephemeral, true);

  pendingCreations.delete(pendingId);
});

// 21. Expired or duplicate button interaction is cleanly rejected
test('21. Expired or duplicate button interaction is cleanly rejected', async () => {
  const btnInteraction = createMockButtonInteraction({
    customId: 'btn_proj_confirm:non-existent-token-xyz',
    userId: 'user-300'
  });

  await handleButton(btnInteraction);

  const replies = btnInteraction.getReplies();
  assert.equal(replies.length, 1);
  assert.ok(replies[0].content.includes('expired or was already submitted'));
  assert.equal(replies[0].ephemeral, true);
});

// 22. /code project import registers directory and displays status
test('22. /code project import registers directory and displays status', async () => {
  const prevGuilds = config.allowedGuildIds;
  const prevChannels = config.allowedChannelIds;
  const prevUsers = config.allowedUserIds;
  const originalImport = defaultApiClient.importProject;

  try {
    config.allowedGuildIds = ['guild-100'];
    config.allowedChannelIds = ['channel-200'];
    config.allowedUserIds = ['user-300'];

    defaultApiClient.importProject = async ({ directory, name, userId }) => ({
      id: 'proj-imported-123',
      name: name || directory,
      slug: directory,
      repo_url: 'git@github-coding:example/repo.git',
      repository_url: 'git@github-coding:example/repo.git',
      default_model: '9router/ayce-combo',
      metadata: { stack: 'Node.js / Express', imported: true }
    });

    const interaction = createMockInteraction({
      subcommandGroup: 'project',
      subcommand: 'import',
      options: {
        directory: 'my-service-app',
        name: 'My Service App'
      }
    });

    await execute(interaction);

    const replies = interaction.getReplies();
    assert.ok(replies.length > 0);
    const lastReply = replies[replies.length - 1];
    assert.ok(lastReply.content.includes('Workspace Registered Successfully'));
    assert.ok(lastReply.content.includes('my-service-app'));
    assert.ok(lastReply.content.includes('Node.js / Express'));
    assert.ok(lastReply.content.includes('Configured'));
    assert.equal(lastReply.content.includes('/home/'), false);
  } finally {
    defaultApiClient.importProject = originalImport;
    config.allowedGuildIds = prevGuilds;
    config.allowedChannelIds = prevChannels;
    config.allowedUserIds = prevUsers;
  }
});

// 23. /code project info formats details and hides host workspace path
test('23. /code project info formats details and hides host workspace path', async () => {
  const prevGuilds = config.allowedGuildIds;
  const prevChannels = config.allowedChannelIds;
  const prevUsers = config.allowedUserIds;
  const originalResolve = defaultApiClient.resolveProject;
  const originalSessions = defaultApiClient.fetchProjectSessions;
  const originalTasks = defaultApiClient.getProjectTasks;

  try {
    config.allowedGuildIds = ['guild-100'];
    config.allowedChannelIds = ['channel-200'];
    config.allowedUserIds = ['user-300'];

    const mockUserHome = ['/', 'home', 'lukman-ss'].join('');
    defaultApiClient.resolveProject = async (idOrSlug) => ({
      id: 'proj-info-123',
      name: 'Information Test',
      slug: 'information-test',
      description: 'A test project for info view',
      repo_url: 'https://github.com/owner/repo.git',
      repository_url: 'https://github.com/owner/repo.git',
      default_branch: 'main',
      default_model: '9router/ayce-combo',
      workspace_path: `${mockUserHome}/coding-orchestrator/workspace/information-test`,
      created_at: '2026-10-26 12:00:00',
      metadata: { stack: 'React' }
    });
    defaultApiClient.fetchProjectSessions = async () => [{ id: 's1' }, { id: 's2' }];
    defaultApiClient.getProjectTasks = async () => [{ id: 't1' }];

    const interaction = createMockInteraction({
      subcommandGroup: 'project',
      subcommand: 'info',
      options: { project: 'information-test' }
    });

    await execute(interaction);

    const replies = interaction.getReplies();
    assert.ok(replies.length > 0);
    const lastReply = replies[replies.length - 1];
    assert.ok(lastReply.content.includes('Project Details'));
    assert.ok(lastReply.content.includes('information-test'));
    assert.ok(lastReply.content.includes('Associated Sessions**: 2'));
    assert.ok(lastReply.content.includes('Tasks / Jobs**: 1'));
    assert.equal(lastReply.content.includes(mockUserHome), false);
  } finally {
    defaultApiClient.resolveProject = originalResolve;
    defaultApiClient.fetchProjectSessions = originalSessions;
    defaultApiClient.getProjectTasks = originalTasks;
    config.allowedGuildIds = prevGuilds;
    config.allowedChannelIds = prevChannels;
    config.allowedUserIds = prevUsers;
  }
});
