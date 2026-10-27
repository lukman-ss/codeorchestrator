import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import apiClient from '../api-client.js';
import auth from '../authorization.js';
import persistence from '../persistence.js';
import config from '../config.js';
import { generateSlug, validateGitHubUrl } from '../../../../src/services/project-service.js';
import { downloadAndValidateAttachment, savePromptArtifact } from '../attachment-service.js';
import {
  formatJobCard,
  formatTaskCard,
  formatAuditReport,
  formatFinalReport,
  formatSpecificationCard,
  formatExecutionStartedCard,
  formatExecutionResultCard,
  formatGitReviewCard,
  formatGitDecisionResultCard,
  redactSensitive,
  safeMentions,
  safeEditReply,
  safeReply,
  formatErrorPayload
} from '../notifications.js';

export const pendingCreations = new Map();

export const data = new SlashCommandBuilder()
  .setName('code')
  .setDescription('CodeOrchestrator management and execution')
  .setDMPermission(false)
  .addSubcommandGroup(group =>
    group
      .setName('project')
      .setDescription('Project workspace operations')
      .addSubcommand(sub =>
        sub
          .setName('create')
          .setDescription('Create a persistent coding project workspace')
          .addStringOption(opt =>
            opt
              .setName('name')
              .setDescription('Project name')
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('import')
          .setDescription('Register an existing directory under WORKSPACE_ROOT as a project')
          .addStringOption(opt =>
            opt
              .setName('directory')
              .setDescription('Directory name inside workspace root')
              .setRequired(true)
          )
          .addStringOption(opt =>
            opt
              .setName('name')
              .setDescription('Optional project display name')
              .setRequired(false)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('info')
          .setDescription('Display detailed information about a project')
          .addStringOption(opt =>
            opt
              .setName('project')
              .setDescription('Project name, slug, or ID')
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('repair')
          .setDescription('Repair project workspace metadata or remote configuration')
          .addStringOption(opt =>
            opt
              .setName('project')
              .setDescription('Project name, slug, or ID')
              .setRequired(true)
              .setAutocomplete(true)
          )
          .addBooleanOption(opt =>
            opt
              .setName('confirm')
              .setDescription('Confirm configuration update')
              .setRequired(true)
          )
          .addStringOption(opt =>
            opt
              .setName('repourl')
              .setDescription('Correct GitHub repository URL')
              .setRequired(false)
          )
          .addStringOption(opt =>
            opt
              .setName('branch')
              .setDescription('Default branch')
              .setRequired(false)
          )
      )
  )
  .addSubcommandGroup(group =>
    group
      .setName('prompt')
      .setDescription('Multipart prompt specification management')
      .addSubcommand(sub =>
        sub
          .setName('start')
          .setDescription('Start collecting multipart specification chunks in this channel')
          .addStringOption(opt =>
            opt
              .setName('project')
              .setDescription('Target project (optional)')
              .setRequired(false)
              .setAutocomplete(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('submit')
          .setDescription('Submit collected chunks as a complete specification')
      )
      .addSubcommand(sub =>
        sub
          .setName('cancel')
          .setDescription('Cancel active multipart prompt collection')
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('projects')
      .setDescription('List registered and authorized coding workspaces')
      .addIntegerOption(opt =>
        opt
          .setName('page')
          .setDescription('Page number')
          .setRequired(false)
          .setMinValue(1)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('sessions')
      .setDescription('List conversational sessions (standalone and project-linked)')
      .addStringOption(opt =>
        opt
          .setName('project')
          .setDescription('Filter sessions by target project')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addIntegerOption(opt =>
        opt
          .setName('page')
          .setDescription('Page number')
          .setRequired(false)
          .setMinValue(1)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('chat')
      .setDescription('Start or continue a standalone conversation (no project required)')
      .addStringOption(opt =>
        opt
          .setName('prompt')
          .setDescription('Your question or message')
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt
          .setName('session')
          .setDescription('Existing session ID to continue')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt
          .setName('model')
          .setDescription('Model override')
          .setRequired(false)
      )
  )
  .addSubcommandGroup(group =>
    group
      .setName('session')
      .setDescription('Session conversation management')
      .addSubcommand(sub =>
        sub
          .setName('new')
          .setDescription('Explicitly create a fresh standalone session')
          .addStringOption(opt =>
            opt
              .setName('title')
              .setDescription('Session title or topic')
              .setRequired(true)
          )
          .addStringOption(opt =>
            opt
              .setName('project')
              .setDescription('Optional project to link workspace context')
              .setRequired(false)
              .setAutocomplete(true)
          )
          .addStringOption(opt =>
            opt
              .setName('model')
              .setDescription('Model override')
              .setRequired(false)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('info')
          .setDescription('Show current conversation/session metadata')
          .addStringOption(opt =>
            opt
              .setName('session')
              .setDescription('Session ID (leave empty for current active conversation)')
              .setRequired(false)
              .setAutocomplete(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('close')
          .setDescription('Close or archive a selected conversation without deleting history')
          .addStringOption(opt =>
            opt
              .setName('session')
              .setDescription('Session ID to close (leave empty for current active conversation)')
              .setRequired(false)
              .setAutocomplete(true)
          )
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('resume')
      .setDescription('Continue an existing session with follow-up message')
      .addStringOption(opt =>
        opt
          .setName('session')
          .setDescription('Session ID to resume')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt
          .setName('prompt')
          .setDescription('Follow-up instructions or question')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('run')
      .setDescription('Submit a simple coding task to a project workspace')
      .addStringOption(opt =>
        opt
          .setName('project')
          .setDescription('Target project name, slug, or ID')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt
          .setName('prompt')
          .setDescription('Task instructions')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('job')
      .setDescription('Submit a multi-agent coding job to a project workspace')
      .addStringOption(opt =>
        opt
          .setName('project')
          .setDescription('Target project name, slug, or ID')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt
          .setName('prompt')
          .setDescription('Job specification prompt')
          .setRequired(false)
      )
      .addAttachmentOption(opt =>
        opt
          .setName('attachment')
          .setDescription('UTF-8 .txt or .md specification file')
          .setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('status')
      .setDescription('Retrieve task or job execution status')
      .addStringOption(opt =>
        opt
          .setName('id')
          .setDescription('Task ID or Job ID')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('audit')
      .setDescription('Retrieve independent audit results')
      .addStringOption(opt =>
        opt
          .setName('id')
          .setDescription('Subtask ID or Job ID')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('report')
      .setDescription('Retrieve final task or job report')
      .addStringOption(opt =>
        opt
          .setName('id')
          .setDescription('Job ID or Task ID')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('cancel')
      .setDescription('Cancel an active task or job')
      .addStringOption(opt =>
        opt
          .setName('id')
          .setDescription('Task ID or Job ID')
          .setRequired(true)
      )
      .addBooleanOption(opt =>
        opt
          .setName('confirm')
          .setDescription('Confirm cancellation')
          .setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('approvals')
      .setDescription('List pending Git approvals awaiting human decision')
      .addStringOption(opt =>
        opt
          .setName('project')
          .setDescription('Filter approvals by project')
          .setRequired(false)
          .setAutocomplete(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('review')
      .setDescription('Review 3-gate completion status and Git diff')
      .addStringOption(opt =>
        opt
          .setName('id')
          .setDescription('Approval ID, Task ID, or Job ID')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('approve')
      .setDescription('Decide on a Git approval request (push or keep local)')
      .addStringOption(opt =>
        opt
          .setName('id')
          .setDescription('Approval ID')
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt
          .setName('decision')
          .setDescription('Decision to apply')
          .setRequired(true)
          .addChoices(
            { name: 'Push to GitHub', value: 'push' },
            { name: 'Keep Local', value: 'keep_local' },
            { name: 'Reject', value: 'reject' }
          )
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('help')
      .setDescription('Display available commands and domain architecture guide')
  );

export async function handleAutocomplete(interaction) {
  try {
    const focusedOption = interaction.options.getFocused(true);
    const userId = interaction.user?.id || interaction.userId;
    const memberRoles = interaction.member?.roles?.cache
      ? Array.from(interaction.member.roles.cache.keys())
      : Array.isArray(interaction.member?.roles)
      ? interaction.member.roles
      : [];

    if (focusedOption.name === 'project') {
      const authCheck = auth.validateInteraction(interaction);
      if (!authCheck.allowed) return interaction.respond([]);

      const projects = await apiClient.fetchProjects({ includeTest: false }).catch(() => []);
      const query = (focusedOption.value || '').toLowerCase();

      const allowedProjects = projects
        .filter(p => !p.is_test)
        .filter(p => auth.isProjectAllowedForUser(userId, memberRoles, p));

      const filtered = allowedProjects.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.slug.toLowerCase().includes(query) ||
        p.id.toLowerCase().includes(query)
      );

      const choices = filtered.slice(0, 25).map(p => ({
        name: `${p.name} (${p.slug})`.slice(0, 100),
        value: p.id
      }));

      return interaction.respond(choices);
    }

    if (focusedOption.name === 'session') {
      const sessions = await apiClient.fetchSessions({ limit: 50 }).catch(() => []);
      const query = (focusedOption.value || '').toLowerCase();

      const allowedSessions = sessions.filter(s =>
        auth.isSessionAllowedForUser(userId, memberRoles, s)
      );

      const filtered = allowedSessions.filter(s =>
        (s.title && s.title.toLowerCase().includes(query)) ||
        s.id.toLowerCase().includes(query) ||
        (s.session_type && s.session_type.toLowerCase().includes(query))
      );

      const choices = filtered.slice(0, 25).map(s => {
        const typeTag = s.session_type === 'standalone' ? '[Standalone]' : '[Project]';
        const title = s.title || 'Untitled Session';
        return {
          name: `${typeTag} ${title} (${s.id.slice(0, 8)})`.slice(0, 100),
          value: s.id
        };
      });

      return interaction.respond(choices);
    }
  } catch {
    try {
      await interaction.respond([]);
    } catch {}
  }
}

export async function execute(interaction, eventListener = null) {
  const group = typeof interaction.options.getSubcommandGroup === 'function'
    ? interaction.options.getSubcommandGroup(false)
    : null;
  const subcommand = interaction.options.getSubcommand();
  const commandKey = group ? `${group}:${subcommand}` : subcommand;

  if (commandKey === 'project:create') {
    const authCheck = auth.validateInteraction(interaction, 'project:create');
    if (!authCheck.allowed) {
      return safeReply(interaction, {
        content: `❌ **Access Denied**: ${authCheck.reason}`,
        ephemeral: true,
        allowedMentions: safeMentions
      }, { type: 'auth_denied' });
    }

    const name = interaction.options.getString('name', true);

    const modal = new ModalBuilder()
      .setCustomId('modal_project_create')
      .setTitle('Create Coding Project');

    const nameInput = new TextInputBuilder()
      .setCustomId('proj_name')
      .setLabel('Project Name *')
      .setStyle(TextInputStyle.Short)
      .setValue(name)
      .setRequired(true)
      .setMaxLength(100);

    const descInput = new TextInputBuilder()
      .setCustomId('proj_desc')
      .setLabel('Description')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Project purpose or description')
      .setRequired(false)
      .setMaxLength(500);

    const repoInput = new TextInputBuilder()
      .setCustomId('proj_repo_url')
      .setLabel('GitHub Repository URL')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('https://github.com/owner/repo.git or git@github-coding:...')
      .setRequired(false)
      .setMaxLength(255);

    const branchInput = new TextInputBuilder()
      .setCustomId('proj_branch')
      .setLabel('Git Branch')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Leave empty for default branch (e.g. main/master)')
      .setRequired(false)
      .setMaxLength(100);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(descInput),
      new ActionRowBuilder().addComponents(repoInput),
      new ActionRowBuilder().addComponents(branchInput)
    );

    return await interaction.showModal(modal);
  }

  const authCheck = auth.validateInteraction(interaction, commandKey);
  if (!authCheck.allowed) {
    return safeReply(interaction, {
      content: `❌ **Access Denied**: ${authCheck.reason}`,
      ephemeral: true,
      allowedMentions: safeMentions
    }, { type: 'auth_denied' });
  }

  await interaction.deferReply();

  const userId = interaction.user?.id || interaction.userId;
  const memberRoles = interaction.member?.roles?.cache
    ? Array.from(interaction.member.roles.cache.keys())
    : Array.isArray(interaction.member?.roles)
    ? interaction.member.roles
    : [];

  try {
    switch (commandKey) {
      case 'project:import':
        return await handleProjectImport(interaction, userId, memberRoles);
      case 'project:info':
        return await handleProjectInfo(interaction, userId, memberRoles);
      case 'project:repair':
        return await handleProjectRepair(interaction, userId, memberRoles);
      case 'prompt:start':
        return await handlePromptStart(interaction, userId, memberRoles);
      case 'prompt:submit':
        return await handlePromptSubmit(interaction, userId, memberRoles);
      case 'prompt:cancel':
        return await handlePromptCancel(interaction, userId, memberRoles);
      case 'projects':
        return await handleProjects(interaction, userId, memberRoles);
      case 'sessions':
        return await handleSessions(interaction, userId, memberRoles);
      case 'chat':
        return await handleChat(interaction, userId, memberRoles);
      case 'session':
      case 'session:new':
        return await handleSessionNew(interaction, userId, memberRoles);
      case 'session:info':
        return await handleSessionInfo(interaction, userId, memberRoles);
      case 'session:close':
        return await handleSessionClose(interaction, userId, memberRoles);
      case 'resume':
        return await handleResume(interaction, userId, memberRoles);
      case 'run':
        return await handleRun(interaction, userId, memberRoles, eventListener);
      case 'job':
        return await handleJob(interaction, userId, memberRoles, eventListener);
      case 'status':
        return await handleStatus(interaction, userId, memberRoles);
      case 'audit':
        return await handleAudit(interaction, userId, memberRoles);
      case 'report':
        return await handleReport(interaction, userId, memberRoles);
      case 'approvals':
        return await handleApprovals(interaction, userId, memberRoles);
      case 'review':
        return await handleReview(interaction, userId, memberRoles);
      case 'approve':
        return await handleApprove(interaction, userId, memberRoles);
      case 'cancel':
        return await handleCancel(interaction, userId, memberRoles);
      case 'help':
        return await handleHelp(interaction);
      default:
        return await safeEditReply(interaction, {
          content: 'Unknown subcommand.',
          allowedMentions: safeMentions
        }, { type: 'unknown_command' });
    }
  } catch (err) {
    return await safeEditReply(interaction, formatErrorPayload(err, { type: 'command_error' }));
  }
}

async function handleProjectImport(interaction, userId, memberRoles) {
  const directory = interaction.options.getString('directory', true);
  const name = interaction.options.getString('name') || directory;

  try {
    const project = await apiClient.importProject({ directory, name, userId });
    const gitStatus = project.repo_url || project.repository_url ? 'Configured' : 'Not configured';
    const lines = [
      '✅ **Workspace Registered Successfully!**',
      '',
      `• **Name**: **${project.name}**`,
      `• **ID**: \`${project.id}\``,
      `• **Workspace**: \`${project.slug}\``,
      `• **Git**: ${gitStatus}`,
      `• **Default Model**: \`${project.default_model || '9router/ayce-combo'}\``
    ];
    if (project.metadata?.stack) {
      lines.push(`• **Technology**: ${project.metadata.stack}`);
    }
    return safeEditReply(interaction, {
      content: lines.join('\n'),
      allowedMentions: safeMentions
    }, { type: 'project_imported' });
  } catch (err) {
    return safeEditReply(interaction, formatErrorPayload(err, { type: 'project_import_error' }));
  }
}

async function handleProjectInfo(interaction, userId, memberRoles) {
  const idOrSlug = interaction.options.getString('project', true);
  const project = await apiClient.resolveProject(idOrSlug);

  if (!project) {
    return safeEditReply(interaction, {
      content: `❌ Project \`${idOrSlug}\` not found.`,
      allowedMentions: safeMentions
    }, { type: 'project_not_found' });
  }

  if (!auth.isProjectAllowedForUser(userId, memberRoles, project)) {
    return safeEditReply(interaction, {
      content: '❌ **Access Denied**: You do not have permission to view this project.',
      allowedMentions: safeMentions
    }, { type: 'project_access_denied' });
  }

  const [sessions, tasks] = await Promise.all([
    apiClient.fetchProjectSessions(project.id).catch(() => []),
    apiClient.getProjectTasks(project.id).catch(() => [])
  ]);

  const gitConfigured = project.repo_url || project.repository_url;
  const lines = [
    '📁 **CodeOrchestrator Project Details**',
    '',
    `• **Name**: **${project.name}**`,
    `• **Project ID**: \`${project.id}\``,
    `• **Description**: ${project.description || 'No description provided'}`,
    `• **Workspace**: \`${project.slug}\``,
    `• **Git Remote**: ${gitConfigured ? `Configured (\`${gitConfigured}\`)` : 'Not configured'}`,
    `• **Current Branch**: \`${project.default_branch || 'main'}\``,
    `• **Default Model**: \`${project.default_model || '9router/ayce-combo'}\``,
    `• **Associated Sessions**: ${sessions.length}`,
    `• **Tasks / Jobs**: ${tasks.length}`,
    `• **Created At**: ${project.created_at}`
  ];

  if (project.metadata?.stack) {
    lines.push(`• **Technology**: ${project.metadata.stack}`);
  }

  const fullText = redactSensitive(lines.join('\n'));
  return safeEditReply(interaction, {
    content: fullText,
    allowedMentions: safeMentions
  }, { type: 'project_info' });
}

async function handleProjectRepair(interaction, userId, memberRoles) {
  const projectInput = interaction.options.getString('project', true);
  const repoUrl = interaction.options.getString('repourl');
  const branch = interaction.options.getString('branch');
  const confirm = interaction.options.getBoolean('confirm', true);

  if (!confirm) {
    return safeEditReply(interaction, {
      content: '❌ Explicit confirmation (`confirm: true`) is required to repair project configuration.',
      allowedMentions: safeMentions
    }, { type: 'repair_error' });
  }

  const project = await apiClient.resolveProject(projectInput);
  if (!project) {
    return safeEditReply(interaction, {
      content: `❌ Project \`${projectInput}\` not found in CodeOrchestrator.`,
      allowedMentions: safeMentions
    }, { type: 'repair_error' });
  }

  if (!auth.isProjectAllowedForUser(userId, memberRoles, project)) {
    return safeEditReply(interaction, {
      content: `❌ Access Denied: You do not have permission to configure project \`${project.slug}\`.`,
      allowedMentions: safeMentions
    }, { type: 'auth_denied' });
  }

  try {
    const updated = await apiClient.repairProject(project.id, {
      repoUrl: repoUrl || undefined,
      defaultBranch: branch || undefined,
      confirm: true
    });

    const lines = [
      '✅ **Project Repaired Successfully**',
      '',
      `• **Project**: **${updated.name}** (\`${updated.slug}\`)`,
      `• **Configured Remote**: \`${updated.repo_url || updated.repository_url || 'N/A'}\``,
      `• **Default Branch**: \`${updated.default_branch || 'main'}\``,
      `• **Repaired At**: \`${updated.metadata?.repairedAt || 'now'}\``,
      '',
      'ℹ️ *Note: Workspace filesystem checkout was safely preserved without disk deletion or silent remote mutation.*'
    ];

    return safeEditReply(interaction, {
      content: redactSensitive(lines.join('\n')),
      allowedMentions: safeMentions
    }, { type: 'repair_success' });
  } catch (err) {
    return safeEditReply(interaction, {
      content: redactSensitive(`❌ **Repair Failed**: ${err.message}`),
      allowedMentions: safeMentions
    }, { type: 'repair_error' });
  }
}

async function handlePromptStart(interaction, userId, memberRoles) {
  const projectInput = interaction.options.getString('project');
  let targetProjectId = null;
  let targetProjectSlug = null;

  if (projectInput) {
    const project = await apiClient.resolveProject(projectInput);
    if (!project) {
      return safeEditReply(interaction, {
        content: `❌ Project \`${projectInput}\` not found in CodeOrchestrator.`,
        allowedMentions: safeMentions
      }, { type: 'prompt_error' });
    }
    if (!auth.isProjectAllowedForUser(userId, memberRoles, project)) {
      return safeEditReply(interaction, {
        content: `❌ Access Denied: You do not have permission on project \`${project.slug}\`.`,
        allowedMentions: safeMentions
      }, { type: 'auth_denied' });
    }
    targetProjectId = project.id;
    targetProjectSlug = project.slug;
  }

  const mpId = randomUUID();
  persistence.startMultipartPrompt({
    id: mpId,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId,
    projectId: targetProjectId
  });

  const lines = [
    '📝 **Multipart Specification Started**',
    '',
    `• **ID**: \`${mpId}\``,
    `• **Target**: ${targetProjectSlug ? `Project \`${targetProjectSlug}\`` : 'Standalone Session'}`,
    '',
    'Send your specification messages or `.txt`/`.md` attachments in this channel. They will be collected sequentially.',
    'When finished, run `/code prompt submit`. To cancel, run `/code prompt cancel`.'
  ];

  return safeEditReply(interaction, {
    content: redactSensitive(lines.join('\n')),
    allowedMentions: safeMentions
  }, { type: 'prompt_start' });
}

async function handlePromptSubmit(interaction, userId, memberRoles) {
  const activeMp = persistence.getActiveMultipartPrompt({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId
  });

  if (!activeMp) {
    return safeEditReply(interaction, {
      content: '❌ No active multipart prompt collection in this channel. Run `/code prompt start` first.',
      allowedMentions: safeMentions
    }, { type: 'prompt_error' });
  }

  const chunks = persistence.getMultipartChunks(activeMp.id);
  if (!chunks || chunks.length === 0) {
    return safeEditReply(interaction, {
      content: '❌ No prompt chunks were received. Send at least one chunk in this channel before submitting, or run `/code prompt cancel`.',
      allowedMentions: safeMentions
    }, { type: 'prompt_error' });
  }

  const assembledPrompt = chunks.map(c => c.content).join('\n\n');
  const buffer = Buffer.from(assembledPrompt, 'utf8');

  if (buffer.length === 0) {
    return safeEditReply(interaction, {
      content: '❌ Assembled specification is empty.',
      allowedMentions: safeMentions
    }, { type: 'prompt_error' });
  }

  if (buffer.includes(0)) {
    return safeEditReply(interaction, {
      content: '❌ Assembled specification contains invalid binary or null bytes.',
      allowedMentions: safeMentions
    }, { type: 'prompt_error' });
  }

  const artifact = savePromptArtifact(buffer, 'multipart-specification.md');
  persistence.submitMultipartPrompt(activeMp.id, artifact.artifactPath);

  let project = null;
  if (activeMp.project_id) {
    project = await apiClient.getProject(activeMp.project_id).catch(() => null);
  }

  const subId = randomUUID();
  const submission = persistence.saveSubmission({
    id: subId,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId,
    submissionType: 'multipart',
    inputMethod: 'multipart_prompt',
    projectId: activeMp.project_id,
    promptHash: artifact.sha256,
    promptLength: artifact.sizeBytes,
    artifactPath: artifact.artifactPath,
    status: 'received',
    metadata: {
      totalChunks: chunks.length,
      multipartPromptId: activeMp.id
    }
  });

  const card = formatSpecificationCard(submission, {
    projectSlug: project?.slug,
    filename: `multipart (${chunks.length} chunks)`
  });

  const replyMsg = await safeEditReply(interaction, card, { type: 'prompt_submitted' });
  if (replyMsg?.id) {
    persistence.updateSubmission(subId, { messageId: replyMsg.id });
  }
  return replyMsg;
}

async function handlePromptCancel(interaction, userId, memberRoles) {
  const activeMp = persistence.getActiveMultipartPrompt({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId
  });

  if (!activeMp) {
    return safeEditReply(interaction, {
      content: '❌ No active multipart prompt collection in this channel to cancel.',
      allowedMentions: safeMentions
    }, { type: 'prompt_error' });
  }

  persistence.cancelMultipartPrompt(activeMp.id);
  return safeEditReply(interaction, {
    content: '🚫 Multipart specification collection cancelled.',
    allowedMentions: safeMentions
  }, { type: 'prompt_cancelled' });
}

export async function handleModalSubmit(interaction) {
  if (interaction.customId === 'modal_project_create') {
    const userId = interaction.user?.id || interaction.userId;
    const memberRoles = interaction.member?.roles?.cache
      ? Array.from(interaction.member.roles.cache.keys())
      : Array.isArray(interaction.member?.roles)
      ? interaction.member.roles
      : [];

    const authCheck = auth.validateInteraction(interaction, 'project:create');
    if (!authCheck.allowed) {
      return safeReply(interaction, {
        content: `❌ **Access Denied**: ${authCheck.reason}`,
        ephemeral: true,
        allowedMentions: safeMentions
      }, { type: 'auth_denied' });
    }

    const name = interaction.fields.getTextInputValue('proj_name')?.trim();
    const description = interaction.fields.getTextInputValue('proj_desc')?.trim() || '';
    const repoUrl = interaction.fields.getTextInputValue('proj_repo_url')?.trim() || '';
    const branch = interaction.fields.getTextInputValue('proj_branch')?.trim() || '';

    const slug = generateSlug(name);
    if (!slug) {
      return safeReply(interaction, {
        content: '❌ **Invalid Project Name**: Name must contain valid alphanumeric characters.',
        ephemeral: true,
        allowedMentions: safeMentions
      }, { type: 'validation_error' });
    }

    if (repoUrl) {
      const urlCheck = validateGitHubUrl(repoUrl);
      if (!urlCheck.valid) {
        return safeReply(interaction, {
          content: `❌ **Invalid GitHub URL**: ${urlCheck.error}`,
          ephemeral: true,
          allowedMentions: safeMentions
        }, { type: 'validation_error' });
      }
    }

    const pendingId = randomUUID();
    pendingCreations.set(pendingId, {
      userId,
      name,
      slug,
      description,
      repoUrl: repoUrl || null,
      branch: branch || null,
      defaultModel: '9router/ayce-combo',
      timestamp: Date.now()
    });

    const lines = [
      '### Project Configuration',
      '',
      `• **Name**: ${name}`,
      `• **Slug**: \`${slug}\``,
      `• **GitHub**: ${repoUrl || 'Not configured'}`,
      `• **Mode**: ${repoUrl ? 'Clone existing repository' : 'New local project'}`,
      `• **Branch**: ${branch || (repoUrl ? 'Repository default' : 'N/A')}`,
      `• **Model**: \`9router/ayce-combo\``,
      ''
    ];

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`btn_proj_confirm:${pendingId}`)
      .setLabel('Create Project')
      .setStyle(ButtonStyle.Success);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`btn_proj_cancel:${pendingId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);

    return safeReply(interaction, {
      content: lines.join('\n'),
      components: [row],
      ephemeral: true,
      allowedMentions: safeMentions
    }, { type: 'project_confirmation' });
  }
}

export async function handleButton(interaction) {
  const customId = interaction.customId;
  const userId = interaction.user?.id || interaction.userId;

  if (customId.startsWith('btn_sub_cancel_')) {
    const subId = customId.replace('btn_sub_cancel_', '');
    const submission = persistence.getSubmission(subId);
    if (!submission) {
      return safeReply(interaction, { content: '⚠️ Submission not found or expired.', ephemeral: true });
    }
    const memberRoles = interaction.member?.roles?.cache
      ? Array.from(interaction.member.roles.cache.keys())
      : Array.isArray(interaction.member?.roles) ? interaction.member.roles : [];
    const isAdmin = auth.isAdmin(userId, memberRoles);
    if (submission.user_id !== userId && !isAdmin) {
      return safeReply(interaction, { content: '❌ Only the submitter or an administrator can cancel this specification.', ephemeral: true });
    }
    persistence.updateSubmission(subId, { status: 'cancelled' });
    return interaction.update({
      content: '🚫 Specification execution cancelled.',
      components: []
    });
  }

  if (customId.startsWith('btn_sub_exec_')) {
    const subId = customId.replace('btn_sub_exec_', '');
    const submission = persistence.getSubmission(subId);
    if (!submission) {
      return safeReply(interaction, { content: '⚠️ Submission not found or expired.', ephemeral: true });
    }
    const memberRoles = interaction.member?.roles?.cache
      ? Array.from(interaction.member.roles.cache.keys())
      : Array.isArray(interaction.member?.roles) ? interaction.member.roles : [];
    const isAdmin = auth.isAdmin(userId, memberRoles);
    if (submission.user_id !== userId && !isAdmin) {
      return safeReply(interaction, { content: '❌ Only the submitter or an administrator can execute this specification.', ephemeral: true });
    }
    if (submission.status !== 'received' && submission.status !== 'confirmed') {
      return safeReply(interaction, { content: `⚠️ This specification is already in state '${submission.status}'.`, ephemeral: true });
    }

    // Workspace validation check before mutation if project is targeted!
    let project = null;
    if (submission.project_id) {
      try {
        project = await apiClient.getProject(submission.project_id);
        const wsCheck = await apiClient.validateProject(submission.project_id);
        if (!wsCheck.valid) {
          persistence.updateSubmission(subId, { status: 'failed' });
          return interaction.update({
            content: redactSensitive(`❌ **Workspace Validation Failed**: ${wsCheck.error}`),
            components: []
          });
        }
      } catch (err) {
        persistence.updateSubmission(subId, { status: 'failed' });
        return interaction.update({
          content: redactSensitive(`❌ **Workspace Error**: ${err.message}`),
          components: []
        });
      }
    }

    persistence.updateSubmission(subId, { status: 'executing' });

    let promptContent = '';
    if (submission.artifact_path && existsSync(submission.artifact_path)) {
      promptContent = readFileSync(submission.artifact_path, 'utf8');
    } else {
      promptContent = submission.metadata?.prompt || '';
    }

    const startCard = formatExecutionStartedCard(submission, { projectSlug: project?.slug });
    await interaction.update(startCard);

    try {
      let executionResult = null;
      if (submission.project_id) {
        if (submission.submission_type === 'job') {
          const job = await apiClient.createJob(submission.project_id, promptContent);
          persistence.updateSubmission(subId, { executionId: job.id, status: 'completed' });
          persistence.saveExecution({
            id: job.id,
            kind: 'job',
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            userId,
            messageId: interaction.message?.id || null,
            projectId: submission.project_id,
            projectSlug: project?.slug,
            promptSnippet: promptContent.slice(0, 100),
            status: 'queued'
          });
          executionResult = { status: 'queued', output: `Job created with ID: ${job.id}` };
        } else {
          const task = await apiClient.createTask(submission.project_id, {
            prompt: promptContent,
            sessionId: submission.session_id
          });
          persistence.updateSubmission(subId, { executionId: task.id, status: 'completed' });
          persistence.saveExecution({
            id: task.id,
            kind: 'task',
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            userId,
            messageId: interaction.message?.id || null,
            projectId: submission.project_id,
            projectSlug: project?.slug,
            promptSnippet: promptContent.slice(0, 100),
            status: task.status || 'queued'
          });
          executionResult = { status: 'queued', output: `Task queued with ID: ${task.id}` };
        }
      } else if (submission.session_id) {
        await apiClient.sendSessionMessageAsync(submission.session_id, {
          prompt: promptContent,
          userId
        });
        persistence.updateSubmission(subId, { status: 'completed' });
        persistence.saveExecution({
          id: submission.session_id,
          kind: 'session',
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId,
          messageId: interaction.message?.id || null,
          promptSnippet: promptContent.slice(0, 100),
          status: 'running'
        });
        executionResult = { status: 'running', output: 'Session executing in background (WS tracked)' };
      } else {
        const session = await apiClient.createSession({
          title: promptContent.slice(0, 50).trim() || 'Specification Execution',
          type: 'standalone',
          userId
        });
        persistence.updateSubmission(subId, { sessionId: session.id });
        await apiClient.sendSessionMessageAsync(session.id, {
          prompt: promptContent,
          userId
        });
        persistence.updateSubmission(subId, { status: 'completed' });
        persistence.saveExecution({
          id: session.id,
          kind: 'session',
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId,
          messageId: interaction.message?.id || null,
          promptSnippet: promptContent.slice(0, 100),
          status: 'running'
        });
        executionResult = { status: 'running', output: 'Session executing in background (WS tracked)' };
      }

      const resultCard = formatExecutionResultCard(submission, executionResult, { projectSlug: project?.slug });
      try {
        await interaction.editReply(resultCard);
      } catch {
        if (interaction.channel && typeof interaction.channel.send === 'function') {
          await interaction.channel.send(resultCard).catch(() => {});
        }
      }
    } catch (err) {
      persistence.updateSubmission(subId, { status: 'failed' });
      const failPayload = {
        content: redactSensitive(`❌ **Execution Failed**: ${err.message}`),
        components: []
      };
      try {
        await interaction.editReply(failPayload);
      } catch {
        if (interaction.channel && typeof interaction.channel.send === 'function') {
          await interaction.channel.send(failPayload).catch(() => {});
        }
      }
    }
    return;
  }

  if (customId.startsWith('btn_proj_cancel:')) {
    const pendingId = customId.replace('btn_proj_cancel:', '');
    const pending = pendingCreations.get(pendingId);
    if (pending && pending.userId !== userId) {
      return safeReply(interaction, { content: 'Only the original requester can cancel this setup.', ephemeral: true });
    }
    pendingCreations.delete(pendingId);
    return interaction.update({
      content: '🚫 Project creation cancelled.',
      components: []
    });
  }

  if (customId.startsWith('btn_proj_confirm:')) {
    const pendingId = customId.replace('btn_proj_confirm:', '');
    const pending = pendingCreations.get(pendingId);
    if (!pending) {
      return safeReply(interaction, {
        content: '⚠️ This setup has expired or was already submitted.',
        ephemeral: true
      });
    }
    if (pending.userId !== userId) {
      return safeReply(interaction, {
        content: 'Only the original requester can confirm this creation.',
        ephemeral: true
      });
    }

    // Double submission prevention: remove immediately!
    pendingCreations.delete(pendingId);

    await interaction.update({
      content: `⏳ Initializing project **${pending.name}**...`,
      components: []
    });

    try {
      const opRes = await apiClient.createProjectAsync({
        name: pending.name,
        slug: pending.slug,
        description: pending.description || undefined,
        repoUrl: pending.repoUrl || undefined,
        branch: pending.branch || undefined,
        defaultModel: pending.defaultModel,
        userId
      });

      const operationId = opRes.operationId;
      let finalResult = null;
      let finalError = null;

      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const op = await apiClient.getProjectOperation(operationId);
        if (!op) break;

        if (op.status === 'cloning') {
          await safeEditReply(interaction, {
            content: `⏳ Cloning repository \`${pending.repoUrl}\` (branch: \`${pending.branch || 'default'}\`)...`
          }, { type: 'project_progress' }).catch(() => {});
        } else if (op.status === 'registering') {
          await safeEditReply(interaction, {
            content: '⏳ Registering project workspace in database...'
          }, { type: 'project_progress' }).catch(() => {});
        } else if (op.status === 'completed') {
          finalResult = op.result;
          break;
        } else if (op.status === 'failed') {
          finalError = op.error;
          break;
        }
      }

      if (finalError) {
        return safeEditReply(interaction, {
          content: `❌ **Project Creation Failed**: ${redactSensitive(finalError)}`,
          components: [],
          allowedMentions: safeMentions
        }, { type: 'project_error' });
      }

      if (!finalResult) {
        return safeEditReply(interaction, {
          content: '❌ **Project Creation Timed Out**: Workspace creation took longer than expected.',
          components: [],
          allowedMentions: safeMentions
        }, { type: 'project_timeout' });
      }

      const successLines = [
        '✅ **Project Created Successfully!**',
        '',
        `• **Name**: **${finalResult.name}**`,
        `• **ID**: \`${finalResult.id}\``,
        `• **Slug**: \`${finalResult.slug}\``,
        `• **Workspace**: \`${finalResult.slug}\``,
        `• **Git Remote**: ${finalResult.repo_url ? `\`${finalResult.repo_url}\`` : 'Not configured'}`,
        `• **Branch**: \`${finalResult.default_branch || 'main'}\``,
        `• **Default Model**: \`${finalResult.default_model}\``
      ];
      if (finalResult.metadata?.stack) {
        successLines.push(`• **Technology**: ${finalResult.metadata.stack}`);
      }

      return safeEditReply(interaction, {
        content: redactSensitive(successLines.join('\n')),
        components: [],
        allowedMentions: safeMentions
      }, { type: 'project_success' });
    } catch (err) {
      return safeEditReply(interaction, {
        content: redactSensitive(`❌ **Project Creation Failed**: ${err.message}`),
        components: [],
        allowedMentions: safeMentions
      }, { type: 'project_error' });
    }
  }

  if (customId.startsWith('btn_git_push_') || customId.startsWith('btn_git_keeplocal_') || customId.startsWith('btn_git_reject_')) {
    let decision = 'push';
    let approvalId = '';
    if (customId.startsWith('btn_git_push_')) {
      decision = 'push';
      approvalId = customId.replace('btn_git_push_', '');
    } else if (customId.startsWith('btn_git_keeplocal_')) {
      decision = 'keep_local';
      approvalId = customId.replace('btn_git_keeplocal_', '');
    } else {
      decision = 'reject';
      approvalId = customId.replace('btn_git_reject_', '');
    }

    try {
      const approval = await apiClient.getApproval(approvalId);
      if (!approval) {
        return safeReply(interaction, { content: '❌ Approval request not found or expired.', ephemeral: true });
      }

      await interaction.update({
        content: `⏳ Processing decision \`${decision}\` for approval \`${approvalId}\`...`,
        components: []
      });

      const res = await apiClient.decideApproval(approvalId, { decision, userId });
      const card = formatGitDecisionResultCard(approval, decision, {
        commitSha: res.commitSha,
        error: res.pushFailed ? res.reason : null
      });

      return safeEditReply(interaction, card);
    } catch (err) {
      return safeEditReply(interaction, {
        content: redactSensitive(`❌ **Approval Decision Failed**: ${err.message}`),
        components: []
      });
    }
  }
}

async function handleApprovals(interaction, userId, memberRoles) {
  const projectInput = interaction.options.getString('project');
  let projectId = null;
  if (projectInput) {
    const proj = await apiClient.resolveProject(projectInput);
    if (!proj) {
      return safeEditReply(interaction, { content: `Project '${projectInput}' not found.` });
    }
    if (!auth.isProjectAllowedForUser(userId, memberRoles, proj)) {
      return safeEditReply(interaction, { content: '❌ Access Denied: You do not have access to this project.' });
    }
    projectId = proj.id;
  }

  const items = await apiClient.listPendingApprovals(projectId);
  if (!items || items.length === 0) {
    return safeEditReply(interaction, {
      content: '✅ No pending Git approvals awaiting decision.',
      allowedMentions: safeMentions
    });
  }

  const lines = [
    `### 📋 Pending Git Approvals (${items.length})`,
    ''
  ];

  for (const item of items) {
    let diff = {};
    try { diff = typeof item.diff_summary === 'object' ? item.diff_summary : JSON.parse(item.diff_summary_json || '{}'); } catch {}
    let files = [];
    try { files = Array.isArray(item.files_changed) ? item.files_changed : JSON.parse(item.files_changed_json || '[]'); } catch {}
    const target = `${item.repository_identity} (${item.target_branch})`;
    lines.push(`• **Approval**: \`${item.id}\``);
    lines.push(`  - **Target**: \`${target}\``);
    if (item.task_id) lines.push(`  - **Task**: \`${item.task_id}\``);
    if (item.job_id) lines.push(`  - **Job**: \`${item.job_id}\``);
    lines.push(`  - **Changes**: ${files.length} file(s) (+${diff.added || 0} ~${diff.modified || 0} -${diff.deleted || 0})`);
    lines.push(`  - **Created**: <t:${Math.floor(new Date(item.created_at).getTime() / 1000)}:R>`);
    lines.push('');
  }

  lines.push('Use `/code review <id>` to inspect details or `/code approve <id> <decision>` to decide.');

  return safeEditReply(interaction, {
    content: redactSensitive(lines.join('\n')),
    allowedMentions: safeMentions
  });
}

async function handleReview(interaction, userId, memberRoles) {
  const id = interaction.options.getString('id', true).trim();

  let approval = null;
  let review = null;

  try {
    approval = await apiClient.getApproval(id);
  } catch {}

  if (!approval) {
    try {
      const taskReviewRes = await apiClient.getTaskReview(id);
      approval = taskReviewRes.approval;
      review = taskReviewRes.review;
    } catch {}
  }

  if (!approval && !review) {
    try {
      const jobReviewRes = await apiClient.getJobReview(id);
      approval = jobReviewRes.approval;
      review = jobReviewRes.review;
    } catch {}
  }

  if (!approval && !review) {
    return safeEditReply(interaction, {
      content: `❌ No completion gate review or approval found for \`${id}\`.`,
      allowedMentions: safeMentions
    });
  }

  if (approval) {
    const card = formatGitReviewCard(approval, { review });
    if (approval.status !== 'pending') {
      card.components = [];
      card.content += `\n\n*(Status: **${approval.status}**)*`;
    }
    return safeEditReply(interaction, card);
  }

  const rep = review.report || {};
  const lines = [
    '### 🛡️ CodeOrchestrator — Completion Gate Review',
    `**Review ID**: \`${review.id}\``,
    review.task_id ? `**Task ID**: \`${review.task_id}\`` : (review.job_id ? `**Job ID**: \`${review.job_id}\`` : ''),
    `**Workflow Status**: \`${review.workflow_status}\``,
    '',
    `• Gate 1 (Verification): **${review.acceptance_status}**`,
    `• Gate 2 (Security Audit): **${review.security_status}**`,
    `• Gate 3 (Git Status): **${review.git_status}**`
  ];
  if (rep.gitError) lines.push(`\n**Git Error**: \`${rep.gitError}\``);
  if (rep.verification?.evidenceSummary) lines.push(`\n**Verification**: ${rep.verification.evidenceSummary}`);

  return safeEditReply(interaction, {
    content: redactSensitive(lines.join('\n')),
    allowedMentions: safeMentions
  });
}

async function handleApprove(interaction, userId, memberRoles) {
  const id = interaction.options.getString('id', true).trim();
  const decision = interaction.options.getString('decision', true);

  try {
    const approval = await apiClient.getApproval(id);
    if (!approval) {
      return safeEditReply(interaction, {
        content: `❌ Approval request \`${id}\` not found.`,
        allowedMentions: safeMentions
      });
    }

    if (approval.status !== 'pending') {
      return safeEditReply(interaction, {
        content: `⚠️ Approval request \`${id}\` is already in status '${approval.status}'.`,
        allowedMentions: safeMentions
      });
    }

    const res = await apiClient.decideApproval(id, { decision, userId });
    const card = formatGitDecisionResultCard(approval, decision, {
      commitSha: res.commitSha,
      error: res.pushFailed ? res.reason : null
    });

    return safeEditReply(interaction, card);
  } catch (err) {
    return safeEditReply(interaction, {
      content: redactSensitive(`❌ **Approval Decision Failed**: ${err.message}`),
      allowedMentions: safeMentions
    });
  }
}

async function handleProjects(interaction, userId, memberRoles) {
  const page = interaction.options.getInteger('page') || 1;
  const pageSize = 5;

  const projects = await apiClient.fetchProjects({ includeTest: false });
  const accessible = projects
    .filter(p => !p.is_test)
    .filter(p => auth.isProjectAllowedForUser(userId, memberRoles, p));

  if (accessible.length === 0) {
    return safeEditReply(interaction, {
      content: 'No registered coding projects found or you lack permission to view available projects.',
      allowedMentions: safeMentions
    }, { type: 'projects' });
  }

  const totalPages = Math.ceil(accessible.length / pageSize);
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageProjects = accessible.slice(startIndex, startIndex + pageSize);

  const lines = [
    '```',
    `CodeOrchestrator — Projects (Page ${currentPage} of ${totalPages})`,
    ''
  ];

  for (const p of pageProjects) {
    lines.push(`• Name:      ${p.name}`);
    lines.push(`  ID:        ${p.id}`);
    lines.push(`  Workspace: ${p.slug}`);
    lines.push(`  Git:       ${p.repo_url || p.repository_url ? 'Configured' : 'Not configured'}`);
    lines.push(`  Model:     ${p.default_model || 'default'}`);
    lines.push('');
  }
  lines.push('```');

  if (totalPages > 1) {
    lines.push(`_Use \`/code projects page:${currentPage < totalPages ? currentPage + 1 : 1}\` to view more._`);
  }

  const fullText = redactSensitive(lines.join('\n'));

  if (fullText.length > 1800) {
    return safeEditReply(interaction, {
      content: `Projects list (Page ${currentPage} of ${totalPages}) attached below:`,
      files: [new AttachmentBuilder(Buffer.from(fullText, 'utf8'), { name: 'projects.txt' })],
      allowedMentions: safeMentions
    }, { type: 'projects' });
  }

  return safeEditReply(interaction, {
    content: fullText,
    allowedMentions: safeMentions
  }, { type: 'projects' });
}

async function handleSessions(interaction, userId, memberRoles) {
  const projectInput = interaction.options.getString('project');
  const page = interaction.options.getInteger('page') || 1;
  const pageSize = 5;

  let resolvedProject = null;
  let sessions = [];

  if (projectInput) {
    resolvedProject = await apiClient.resolveProject(projectInput);
    if (!resolvedProject) {
      return safeEditReply(interaction, {
        content: `❌ Project \`${projectInput}\` not found in CodeOrchestrator.`,
        allowedMentions: safeMentions
      }, { type: 'sessions_error' });
    }
    if (!auth.isProjectAllowedForUser(userId, memberRoles, resolvedProject)) {
      return safeEditReply(interaction, {
        content: `❌ Access Denied: You do not have permission to view sessions for project \`${resolvedProject.slug}\`.`,
        allowedMentions: safeMentions
      }, { type: 'auth_denied' });
    }
    sessions = await apiClient.fetchSessions({ projectId: resolvedProject.id, limit: 100 });
  } else {
    sessions = await apiClient.fetchSessions({ limit: 100 });
  }

  const accessible = sessions.filter(s => auth.isSessionAllowedForUser(userId, memberRoles, s));

  if (accessible.length === 0) {
    const scopeMsg = resolvedProject ? `under project \`${resolvedProject.slug}\`` : '';
    return safeEditReply(interaction, {
      content: `No sessions found ${scopeMsg}. Use \`/code chat\` or \`/code session\` to start a conversation.`,
      allowedMentions: safeMentions
    }, { type: 'sessions' });
  }

  const totalPages = Math.ceil(accessible.length / pageSize);
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageSessions = accessible.slice(startIndex, startIndex + pageSize);

  const header = resolvedProject
    ? `CodeOrchestrator — Sessions for ${resolvedProject.name} (Page ${currentPage} of ${totalPages})`
    : `CodeOrchestrator — Sessions (Page ${currentPage} of ${totalPages})`;

  const lines = ['```', header, ''];

  for (const s of pageSessions) {
    const isStandalone = s.session_type === 'standalone' || !s.project_id;
    const typeLabel = isStandalone ? 'Standalone' : `Project (${s.project_id.slice(0, 8)})`;
    lines.push(`• Title:   ${s.title || 'Untitled Session'}`);
    lines.push(`  ID:      ${s.id}`);
    lines.push(`  Type:    ${typeLabel}`);
    lines.push(`  Model:   ${s.model || 'default'}`);
    lines.push(`  Status:  ${s.status || 'idle'}`);
    lines.push(`  Updated: ${s.updated_at || s.created_at}`);
    lines.push('');
  }
  lines.push('```');

  if (totalPages > 1) {
    lines.push(`_Use \`/code sessions page:${currentPage < totalPages ? currentPage + 1 : 1}\` to view more._`);
  }

  const fullText = redactSensitive(lines.join('\n'));

  if (fullText.length > 1800) {
    return safeEditReply(interaction, {
      content: `Sessions list (Page ${currentPage} of ${totalPages}) attached below:`,
      files: [new AttachmentBuilder(Buffer.from(fullText, 'utf8'), { name: 'sessions.txt' })],
      allowedMentions: safeMentions
    }, { type: 'sessions' });
  }

  return safeEditReply(interaction, {
    content: fullText,
    allowedMentions: safeMentions
  }, { type: 'sessions' });
}

async function handleChat(interaction, userId, memberRoles) {
  const prompt = interaction.options.getString('prompt', true);
  const sessionInput = interaction.options.getString('session');
  const modelOverride = interaction.options.getString('model') || undefined;

  let session = null;
  let conversationScope = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    threadId: null,
    discordUserId: userId
  };

  if (sessionInput) {
    session = await apiClient.resolveSession(sessionInput);
    if (!session) {
      return safeEditReply(interaction, {
        content: `❌ Session \`${sessionInput}\` not found.`,
        allowedMentions: safeMentions
      }, { type: 'chat_error' });
    }
    if (!auth.isSessionAllowedForUser(userId, memberRoles, session)) {
      return safeEditReply(interaction, {
        content: `❌ Access Denied: You do not have permission to access private session \`${session.id}\`.`,
        allowedMentions: safeMentions
      }, { type: 'auth_denied' });
    }
  } else {
    // Check if user has an active conversation in current channel
    let activeConv = persistence.getActiveConversation(conversationScope);
    if (activeConv) {
      try {
        const s = await apiClient.getSession(activeConv.session_id);
        if (s && s.status !== 'closed') {
          session = s;
        }
      } catch {}
    }

    if (!session) {
      // Create new standalone session
      session = await apiClient.createSession({
        title: prompt.slice(0, 50).trim(),
        type: 'standalone',
        model: modelOverride,
        userId
      });

      activeConv = persistence.createConversation({
        id: randomUUID(),
        guildId: conversationScope.guildId,
        channelId: conversationScope.channelId,
        threadId: conversationScope.threadId,
        discordUserId: userId,
        sessionId: session.id,
        conversationType: 'standalone',
        status: 'active'
      });
    }
  }

  const result = await apiClient.sendSessionMessage(session.id, {
    prompt,
    model: modelOverride,
    userId
  });

  const replyText = result.response || '_(No response returned)_';
  const typeLabel = session.session_type === 'standalone' ? 'Standalone' : 'Project-Linked';

  const header = [
    `**Session:** ${session.title || 'Conversation'}`,
    `**Type:** ${typeLabel}`,
    `**ID:** \`${session.id}\``,
    '',
    '**Response:**'
  ].join('\n');

  const footer = `\n\n_Continue by replying to this message or:_ \`/code resume session:${session.id} prompt:<text>\``;
  const fullContent = redactSensitive(`${header}\n${replyText}${footer}`);

  const reply = await safeEditReply(interaction, {
    content: fullContent,
    allowedMentions: safeMentions
  }, { type: 'chat_response' });

  persistence.saveExecution({
    id: session.id,
    kind: 'session',
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId,
    messageId: reply?.id || 'pending',
    projectId: session.project_id || null,
    promptSnippet: prompt.slice(0, 100),
    status: result.status || 'idle'
  });

  let conv = persistence.getConversationBySessionId(session.id);
  if (!conv) {
    conv = persistence.createConversation({
      id: randomUUID(),
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      discordUserId: userId,
      sessionId: session.id,
      projectId: session.project_id || null,
      conversationType: session.session_type || 'standalone',
      status: 'active'
    });
  } else {
    persistence.updateConversation(conv.id, { last_activity_at: new Date().toISOString() });
  }

  if (reply?.id) {
    persistence.saveSessionMessage({
      id: randomUUID(),
      conversationId: conv.id,
      sessionId: session.id,
      discordMessageId: reply.id,
      referencedMessageId: null,
      messageRole: 'assistant',
      status: 'completed'
    });
  }
}

async function handleSessionNew(interaction, userId, memberRoles) {
  const title = interaction.options.getString('title', true);
  const projectInput = interaction.options.getString('project');
  const model = interaction.options.getString('model') || undefined;

  if (projectInput) {
    const project = await apiClient.resolveProject(projectInput);
    if (!project) {
      return safeEditReply(interaction, {
        content: `❌ Project \`${projectInput}\` not found in CodeOrchestrator.`,
        allowedMentions: safeMentions
      }, { type: 'session_error' });
    }
    if (!auth.isProjectAllowedForUser(userId, memberRoles, project)) {
      return safeEditReply(interaction, {
        content: `❌ Access Denied: You do not have permission to create sessions on project \`${project.slug}\`.`,
        allowedMentions: safeMentions
      }, { type: 'auth_denied' });
    }

    const session = await apiClient.createProjectSession(project.id, {
      title,
      model,
      userId
    });

    persistence.createConversation({
      id: randomUUID(),
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      discordUserId: userId,
      sessionId: session.id,
      projectId: project.id,
      conversationType: 'project',
      status: 'active'
    });

    const lines = [
      '✅ **Project Session Created**',
      `• **Title:** ${session.title}`,
      `• **ID:** \`${session.id}\``,
      `• **Type:** Project-Linked`,
      `• **Project:** \`${project.name}\` (\`${project.slug}\`)`,
      `• **Workspace:** \`${project.workspace_path}\``,
      `• **Model:** \`${session.model || 'default'}\``,
      `• **Status:** \`${session.status}\``,
      '',
      `_Start conversation with:_ \`/code resume session:${session.id} prompt:<text>\` or mention @Agent Coding.`
    ];

    return safeEditReply(interaction, {
      content: lines.join('\n'),
      allowedMentions: safeMentions
    }, { type: 'session_created' });
  }

  // Standalone session
  const session = await apiClient.createSession({
    title,
    type: 'standalone',
    model,
    userId
  });

  persistence.createConversation({
    id: randomUUID(),
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    discordUserId: userId,
    sessionId: session.id,
    conversationType: 'standalone',
    status: 'active'
  });

  const lines = [
    '✅ **Standalone Session Created**',
    `• **Title:** ${session.title}`,
    `• **ID:** \`${session.id}\``,
    `• **Type:** Standalone (Independent OpenCode Conversation)`,
    `• **Model:** \`${session.model || 'default'}\``,
    `• **Status:** \`${session.status}\``,
    '',
    `_Start conversation with:_ \`/code resume session:${session.id} prompt:<text>\` or mention @Agent Coding.`
  ];

  return safeEditReply(interaction, {
    content: lines.join('\n'),
    allowedMentions: safeMentions
  }, { type: 'session_created' });
}

async function handleSessionInfo(interaction, userId, memberRoles) {
  const sessionInput = interaction.options.getString('session');
  let session = null;

  if (sessionInput) {
    session = await apiClient.resolveSession(sessionInput);
    if (!session) {
      return safeEditReply(interaction, {
        content: `❌ Session \`${sessionInput}\` not found.`,
        allowedMentions: safeMentions
      }, { type: 'session_error' });
    }
  } else {
    // Resolve active conversation in scope
    const activeConv = persistence.getActiveConversation({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      discordUserId: userId
    });
    if (!activeConv) {
      return safeEditReply(interaction, {
        content: 'No active conversation found in this channel. Start one by mentioning @Agent Coding or using `/code chat`.',
        allowedMentions: safeMentions
      }, { type: 'session_info' });
    }
    session = await apiClient.getSession(activeConv.session_id).catch(() => null);
    if (!session) {
      return safeEditReply(interaction, {
        content: `❌ Could not retrieve session \`${activeConv.session_id}\` from CodeOrchestrator.`,
        allowedMentions: safeMentions
      }, { type: 'session_error' });
    }
  }

  if (!auth.isSessionAllowedForUser(userId, memberRoles, session)) {
    return safeEditReply(interaction, {
      content: `❌ Access Denied: You do not have permission to view session \`${session.id}\`.`,
      allowedMentions: safeMentions
    }, { type: 'auth_denied' });
  }

  const messages = await apiClient.getSessionMessages(session.id).catch(() => []);
  const isStandalone = session.session_type === 'standalone' || !session.project_id;
  const typeLabel = isStandalone ? 'Standalone' : `Project-Linked (${session.project_id})`;

  const lines = [
    '📋 **Session Information**',
    '',
    `• **Title:** ${session.title || 'Untitled Session'}`,
    `• **Session ID:** \`${session.id}\``,
    `• **OpenCode Session ID:** \`${session.opencode_session_id || 'Not initialized yet'}\``,
    `• **Type:** ${typeLabel}`,
    `• **Status:** \`${session.status || 'idle'}\``,
    `• **Model:** \`${session.model || 'default'}\``,
    `• **Recorded Messages:** ${messages.length}`,
    `• **Created At:** ${session.created_at}`,
    `• **Updated At:** ${session.updated_at || session.created_at}`
  ];

  return safeEditReply(interaction, {
    content: redactSensitive(lines.join('\n')),
    allowedMentions: safeMentions
  }, { type: 'session_info' });
}

async function handleSessionClose(interaction, userId, memberRoles) {
  const sessionInput = interaction.options.getString('session');
  let session = null;
  let conv = null;

  if (sessionInput) {
    session = await apiClient.resolveSession(sessionInput);
    if (!session) {
      return safeEditReply(interaction, {
        content: `❌ Session \`${sessionInput}\` not found.`,
        allowedMentions: safeMentions
      }, { type: 'session_error' });
    }
    conv = persistence.getConversationBySessionId(session.id);
  } else {
    conv = persistence.getActiveConversation({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      discordUserId: userId
    });
    if (!conv) {
      return safeEditReply(interaction, {
        content: 'No active conversation found in this channel to close.',
        allowedMentions: safeMentions
      }, { type: 'session_error' });
    }
    session = await apiClient.getSession(conv.session_id).catch(() => null);
  }

  if (session && !auth.isSessionAllowedForUser(userId, memberRoles, session)) {
    return safeEditReply(interaction, {
      content: `❌ Access Denied: You do not have permission to close session \`${session.id}\`.`,
      allowedMentions: safeMentions
    }, { type: 'auth_denied' });
  }

  if (session) {
    await apiClient.updateSession(session.id, { status: 'closed' }).catch(() => {});
  }
  if (conv) {
    persistence.closeConversation(conv.id);
  }

  const title = session?.title || session?.id || 'current';
  return safeEditReply(interaction, {
    content: `✅ Session **${title}** has been closed and archived. Conversation history is preserved. Next mention will start a fresh session.`,
    allowedMentions: safeMentions
  }, { type: 'session_closed' });
}

async function handleResume(interaction, userId, memberRoles) {
  const sessionInput = interaction.options.getString('session', true);
  const prompt = interaction.options.getString('prompt', true);

  const session = await apiClient.resolveSession(sessionInput);
  if (!session) {
    return safeEditReply(interaction, {
      content: `❌ Session \`${sessionInput}\` not found.`,
      allowedMentions: safeMentions
    }, { type: 'resume_error' });
  }

  if (!auth.isSessionAllowedForUser(userId, memberRoles, session)) {
    return safeEditReply(interaction, {
      content: `❌ Access Denied: You do not have permission to access session \`${session.id}\`.`,
      allowedMentions: safeMentions
    }, { type: 'auth_denied' });
  }

  const result = await apiClient.sendSessionMessage(session.id, {
    prompt,
    userId
  });

  const replyText = result.response || '_(No response returned)_';
  const typeLabel = session.session_type === 'standalone' ? 'Standalone' : 'Project-Linked';

  const header = [
    `**Session:** ${session.title || 'Conversation'}`,
    `**Type:** ${typeLabel}`,
    `**ID:** \`${session.id}\``,
    '',
    '**Response:**'
  ].join('\n');

  const footer = `\n\n_Continue by replying to this message or:_ \`/code resume session:${session.id} prompt:<text>\``;
  const fullContent = redactSensitive(`${header}\n${replyText}${footer}`);

  const reply = await safeEditReply(interaction, {
    content: fullContent,
    allowedMentions: safeMentions
  }, { type: 'resume_response' });

  let conv = persistence.getConversationBySessionId(session.id);
  if (conv) {
    persistence.updateConversation(conv.id, { last_activity_at: new Date().toISOString() });
    if (reply?.id) {
      persistence.saveSessionMessage({
        id: randomUUID(),
        conversationId: conv.id,
        sessionId: session.id,
        discordMessageId: reply.id,
        referencedMessageId: null,
        messageRole: 'assistant',
        status: 'completed'
      });
    }
  }
}

async function handleRun(interaction, userId, memberRoles, eventListener) {
  const projectInput = interaction.options.getString('project', true);
  const prompt = interaction.options.getString('prompt', true);

  const project = await apiClient.resolveProject(projectInput);
  if (!project) {
    return safeEditReply(interaction, {
      content: `❌ Project \`${projectInput}\` not found in CodeOrchestrator.`,
      allowedMentions: safeMentions
    }, { type: 'run_error' });
  }

  if (!auth.isProjectAllowedForUser(userId, memberRoles, project)) {
    return safeEditReply(interaction, {
      content: `❌ Access Denied: You do not have permission to execute tasks on project \`${project.slug}\`.`,
      allowedMentions: safeMentions
    }, { type: 'auth_denied' });
  }

  const taskRes = await apiClient.createTask(project.id, { prompt });
  const taskId = taskRes.id;
  const initialStatus = taskRes.status || 'queued';

  const initialContent = formatTaskCard(
    { id: taskId, project_slug: project.slug, status: initialStatus, prompt },
    { projectSlug: project.slug }
  );

  const trackingNote = `\n_Track with:_ \`/code status id:${taskId}\` _or cancel with:_ \`/code cancel id:${taskId}\``;

  const reply = await safeEditReply(interaction, {
    content: `${initialContent}\n${trackingNote}`,
    allowedMentions: safeMentions
  }, { type: 'task_run' });

  persistence.saveExecution({
    id: taskId,
    kind: 'task',
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId,
    messageId: reply.id,
    projectId: project.id,
    projectSlug: project.slug,
    promptSnippet: prompt.slice(0, 100),
    status: initialStatus
  });
}

async function handleJob(interaction, userId, memberRoles, eventListener) {
  const projectInput = interaction.options.getString('project', true);
  let prompt = interaction.options.getString('prompt') || '';
  const attachment = interaction.options.getAttachment('attachment');

  if (!prompt && !attachment) {
    return safeEditReply(interaction, {
      content: '❌ You must provide either a `prompt` or an `attachment` containing the job specification.',
      allowedMentions: safeMentions
    }, { type: 'job_error' });
  }

  if (attachment) {
    try {
      const downloaded = await downloadAndValidateAttachment(attachment);
      prompt = prompt ? `${prompt}\n\n${downloaded.content}` : downloaded.content;
    } catch (err) {
      return safeEditReply(interaction, {
        content: `❌ ${err.message}`,
        allowedMentions: safeMentions
      }, { type: 'job_error' });
    }
  }

  const project = await apiClient.resolveProject(projectInput);
  if (!project) {
    return safeEditReply(interaction, {
      content: `❌ Project \`${projectInput}\` not found in CodeOrchestrator.`,
      allowedMentions: safeMentions
    }, { type: 'job_error' });
  }

  if (!auth.isProjectAllowedForUser(userId, memberRoles, project)) {
    return safeEditReply(interaction, {
      content: `❌ Access Denied: You do not have permission to execute jobs on project \`${project.slug}\`.`,
      allowedMentions: safeMentions
    }, { type: 'auth_denied' });
  }

  const jobRes = await apiClient.createJob(project.id, prompt);
  const jobId = jobRes.id;

  let jobDetails = await apiClient.getJob(jobId).catch(() => null);
  const totalReq = jobDetails?.total_requirements || 0;
  const initialStatus = jobDetails?.status || 'queued';

  const initialContent = formatJobCard(
    { id: jobId, project_slug: project.slug, status: initialStatus, total_requirements: totalReq, verified_requirements: 0 },
    { projectSlug: project.slug }
  );

  const trackingNote = `\n_Track with:_ \`/code status id:${jobId}\` _or cancel with:_ \`/code cancel id:${jobId}\``;

  const reply = await safeEditReply(interaction, {
    content: `${initialContent}\n${trackingNote}`,
    allowedMentions: safeMentions
  }, { type: 'job_run' });

  persistence.saveExecution({
    id: jobId,
    kind: 'job',
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId,
    messageId: reply.id,
    projectId: project.id,
    projectSlug: project.slug,
    promptSnippet: prompt.slice(0, 100),
    status: initialStatus
  });
}

async function handleStatus(interaction, userId, memberRoles) {
  const id = interaction.options.getString('id', true).trim();

  const job = await apiClient.getJob(id).catch(() => null);
  if (job) {
    if (job.project_id && !auth.isProjectAllowedForUser(userId, memberRoles, { id: job.project_id, slug: job.project_slug })) {
      return safeEditReply(interaction, {
        content: '❌ Access Denied: You do not have permission to view execution details for this project.',
        allowedMentions: safeMentions
      }, { type: 'auth_denied' });
    }
    const agents = await apiClient.getJobAgents(id).catch(() => null);
    const content = formatJobCard(job, { agents });
    return safeEditReply(interaction, {
      content,
      allowedMentions: safeMentions
    }, { type: 'status' });
  }

  const task = await apiClient.getTask(id).catch(() => null);
  if (task) {
    if (task.project_id && !auth.isProjectAllowedForUser(userId, memberRoles, { id: task.project_id, slug: task.project_slug })) {
      return safeEditReply(interaction, {
        content: '❌ Access Denied: You do not have permission to view execution details for this project.',
        allowedMentions: safeMentions
      }, { type: 'auth_denied' });
    }
    const content = formatTaskCard(task);
    return safeEditReply(interaction, {
      content,
      allowedMentions: safeMentions
    }, { type: 'status' });
  }

  return safeEditReply(interaction, {
    content: `❌ No task or job found with ID \`${id}\`.`,
    allowedMentions: safeMentions
  }, { type: 'status_not_found' });
}

async function handleAudit(interaction, userId, memberRoles) {
  const id = interaction.options.getString('id', true).trim();

  const job = await apiClient.getJob(id).catch(() => null);
  if (job && job.project_id && !auth.isProjectAllowedForUser(userId, memberRoles, { id: job.project_id, slug: job.project_slug })) {
    return safeEditReply(interaction, {
      content: '❌ Access Denied: You do not have permission to view audit details for this project.',
      allowedMentions: safeMentions
    }, { type: 'auth_denied' });
  }

  const audits = await apiClient.getSubtaskAudits(id).catch(() => null);
  if (audits && audits.length > 0) {
    const formatted = formatAuditReport(audits, id);
    const replyPayload = {
      content: formatted.content || String(formatted),
      allowedMentions: safeMentions
    };
    if (formatted.attachment) {
      replyPayload.files = [
        new AttachmentBuilder(formatted.attachment.data, { name: formatted.attachment.name })
      ];
    }
    return safeEditReply(interaction, replyPayload, { type: 'audit' });
  }

  const subtasks = await apiClient.getJobSubtasks(id).catch(() => null);
  if (subtasks && subtasks.length > 0) {
    const allAudits = [];
    for (const st of subtasks) {
      const stAudits = await apiClient.getSubtaskAudits(st.id).catch(() => []);
      if (stAudits.length > 0) allAudits.push(...stAudits);
    }
    if (allAudits.length > 0) {
      const formatted = formatAuditReport(allAudits, `Job ${id}`);
      const replyPayload = {
        content: formatted.content || String(formatted),
        allowedMentions: safeMentions
      };
      if (formatted.attachment) {
        replyPayload.files = [
          new AttachmentBuilder(formatted.attachment.data, { name: formatted.attachment.name })
        ];
      }
      return safeEditReply(interaction, replyPayload, { type: 'audit' });
    }
  }

  return safeEditReply(interaction, {
    content: `❌ No audit records found for subtask or job \`${id}\`.`,
    allowedMentions: safeMentions
  }, { type: 'audit_not_found' });
}

async function handleReport(interaction, userId, memberRoles) {
  const id = interaction.options.getString('id', true).trim();

  const job = await apiClient.getJob(id).catch(() => null);
  if (job) {
    if (job.project_id && !auth.isProjectAllowedForUser(userId, memberRoles, { id: job.project_id, slug: job.project_slug })) {
      return safeEditReply(interaction, {
        content: '❌ Access Denied: You do not have permission to view execution reports for this project.',
        allowedMentions: safeMentions
      }, { type: 'auth_denied' });
    }
    const report = await apiClient.getJobReport(id).catch(() => null);
    const formatted = formatFinalReport(report, job);

    const replyPayload = {
      content: formatted.content,
      allowedMentions: safeMentions
    };

    if (formatted.attachment) {
      replyPayload.files = [
        new AttachmentBuilder(formatted.attachment.data, { name: formatted.attachment.name })
      ];
    }

    return safeEditReply(interaction, replyPayload, { type: 'job_report' });
  }

  const task = await apiClient.getTask(id).catch(() => null);
  if (task) {
    if (task.project_id && !auth.isProjectAllowedForUser(userId, memberRoles, { id: task.project_id, slug: task.project_slug })) {
      return safeEditReply(interaction, {
        content: '❌ Access Denied: You do not have permission to view execution reports for this project.',
        allowedMentions: safeMentions
      }, { type: 'auth_denied' });
    }
    const formatted = formatFinalReport(task, task);
    const replyPayload = {
      content: formatted.content,
      allowedMentions: safeMentions
    };

    if (formatted.attachment) {
      replyPayload.files = [
        new AttachmentBuilder(formatted.attachment.data, { name: formatted.attachment.name })
      ];
    }

    return safeEditReply(interaction, replyPayload, { type: 'task_report' });
  }

  return safeEditReply(interaction, {
    content: `❌ No task or job found for report ID \`${id}\`.`,
    allowedMentions: safeMentions
  }, { type: 'report_not_found' });
}

async function handleCancel(interaction, userId, memberRoles) {
  const id = interaction.options.getString('id', true).trim();
  const confirmed = interaction.options.getBoolean('confirm') || false;

  if (!confirmed) {
    const confirmButton = new ButtonBuilder()
      .setCustomId(`confirm_cancel:${id}`)
      .setLabel('Confirm Cancellation')
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(confirmButton);

    return safeEditReply(interaction, {
      content: `⚠️ **Explicit Confirmation Required**\nAre you sure you want to cancel active execution \`${id}\`?\n\nClick below or run: \`/code cancel id:${id} confirm:True\``,
      components: [row],
      allowedMentions: safeMentions
    }, { type: 'cancel_confirm' });
  }

  let cancelResult = null;
  let kind = null;

  try {
    cancelResult = await apiClient.cancelJob(id);
    kind = 'job';
  } catch (jobErr) {
    if (jobErr.status === 404) {
      try {
        cancelResult = await apiClient.cancelTask(id);
        kind = 'task';
      } catch (taskErr) {
        if (taskErr.status === 404) {
          return safeEditReply(interaction, {
            content: `❌ Cannot cancel: No active task or job with ID \`${id}\` found.`,
            components: [],
            allowedMentions: safeMentions
          }, { type: 'cancel_not_found' });
        }
        throw taskErr;
      }
    } else {
      throw jobErr;
    }
  }

  persistence.updateExecution(id, { status: 'cancelled' });

  return safeEditReply(interaction, {
    content: `🛑 Execution \`${id}\` (${kind}) has been cancelled. Status: \`${cancelResult.status || 'cancelled'}\`.`,
    components: [],
    allowedMentions: safeMentions
  }, { type: 'cancel_success' });
}

async function handleHelp(interaction) {
  const helpText = [
    '**CodeOrchestrator Discord Commands**',
    '',
    '**Core Concepts:**',
    '• **Project**: A persistent coding workspace (e.g. `/workspace/bengkelly`). Targets git repositories.',
    '• **Standalone Session**: Persistent OpenCode conversation for Q&A, research, or debugging advice. Independent; no project required.',
    '• **Project Session**: Persistent OpenCode conversation attached to a specific coding workspace.',
    '• **Task**: An individual queued execution request on a project.',
    '• **Job**: Multi-agent workflow with requirement breakdown, workers, and independent audits.',
    '',
    '**Commands:**',
    '`/code project create name:<name>`',
    'Interactively create a persistent project workspace (optional GitHub clone, branch, description).',
    '',
    '`/code project import directory:<dir> [name:<name>]`',
    'Register an existing directory under workspace root as a project.',
    '',
    '`/code project info project:<name|slug|id>`',
    'View detailed project metadata, Git status, session counts, and stack.',
    '',
    '`/code project repair project:<name|slug|id> [repourl:<url>] [branch:<name>] confirm:True`',
    'Repair project workspace metadata or remote configuration safely without checkout deletion.',
    '',
    '`/code prompt start [project:<name>]`',
    'Start collecting multipart specification chunks in this channel.',
    '',
    '`/code prompt submit`',
    'Assemble and submit collected specification chunks as a complete prompt.',
    '',
    '`/code prompt cancel`',
    'Cancel active multipart specification collection.',
    '',
    '`/code chat prompt:<text> [session:<id>] [model:<model>]`',
    'Start or continue a standalone conversation without selecting a project.',
    '',
    '`/code session new title:<text> [project:<name>] [model:<model>]`',
    'Create a standalone session or project-linked session.',
    '',
    '`/code session info session:<id>`',
    'View OpenCode session metadata, turn count, and token usage.',
    '',
    '`/code session close session:<id>`',
    'Close an active OpenCode session.',
    '',
    '`/code resume session:<id> prompt:<text>`',
    'Continue an existing OpenCode session with follow-up message.',
    '',
    '`/code sessions [project:<name>] [page:<num>]`',
    'List authorized sessions (standalone and project-linked).',
    '',
    '`/code projects [page:<num>]`',
    'List accessible coding workspaces.',
    '',
    '`/code run project:<name> prompt:<text>`',
    'Submit a single coding task to a project workspace.',
    '',
    '`/code job project:<name> [prompt:<text>] [attachment:<file>]`',
    'Submit a multi-agent job to a project workspace.',
    '',
    '`/code status id:<id>`',
    'Check task or multi-agent job status.',
    '',
    '`/code audit id:<id>`',
    'View independent auditor reports.',
    '',
    '`/code report id:<id>`',
    'View final execution report and test results.',
    '',
    '`/code cancel id:<id> [confirm:True]`',
    'Cancel an active task or job.'
  ].join('\n');

  return safeEditReply(interaction, {
    content: helpText,
    allowedMentions: safeMentions
  }, { type: 'help' });
}

export default {
  data,
  execute,
  handleAutocomplete,
  handleModalSubmit,
  handleButton
};
