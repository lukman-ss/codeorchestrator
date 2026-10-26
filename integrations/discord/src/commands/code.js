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
import apiClient from '../api-client.js';
import auth from '../authorization.js';
import persistence from '../persistence.js';
import config from '../config.js';
import { generateSlug, validateGitHubUrl } from '../../../../src/services/project-service.js';
import {
  formatJobCard,
  formatTaskCard,
  formatAuditReport,
  formatFinalReport,
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
  .addSubcommand(sub =>
    sub
      .setName('session')
      .setDescription('Create a new session (standalone or project-linked)')
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
      .setPlaceholder('main (leave empty for default)')
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
      case 'projects':
        return await handleProjects(interaction, userId, memberRoles);
      case 'sessions':
        return await handleSessions(interaction, userId, memberRoles);
      case 'chat':
        return await handleChat(interaction, userId, memberRoles);
      case 'session':
        return await handleSession(interaction, userId, memberRoles);
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
        description: pending.description,
        repoUrl: pending.repoUrl,
        branch: pending.branch,
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
    // Create new standalone session
    session = await apiClient.createSession({
      title: prompt.slice(0, 50).trim(),
      type: 'standalone',
      model: modelOverride,
      userId
    });
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

  const footer = `\n\n_Continue with:_ \`/code resume session:${session.id} prompt:<text>\``;
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
}

async function handleSession(interaction, userId, memberRoles) {
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
      `_Start conversation with:_ \`/code resume session:${session.id} prompt:<text>\``
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

  const lines = [
    '✅ **Standalone Session Created**',
    `• **Title:** ${session.title}`,
    `• **ID:** \`${session.id}\``,
    `• **Type:** Standalone (Independent OpenCode Conversation)`,
    `• **Model:** \`${session.model || 'default'}\``,
    `• **Status:** \`${session.status}\``,
    '',
    `_Start conversation with:_ \`/code resume session:${session.id} prompt:<text>\``
  ];

  return safeEditReply(interaction, {
    content: lines.join('\n'),
    allowedMentions: safeMentions
  }, { type: 'session_created' });
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

  const footer = `\n\n_Continue with:_ \`/code resume session:${session.id} prompt:<text>\``;
  const fullContent = redactSensitive(`${header}\n${replyText}${footer}`);

  return safeEditReply(interaction, {
    content: fullContent,
    allowedMentions: safeMentions
  }, { type: 'resume_response' });
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
    const filename = attachment.name.toLowerCase();
    if (!filename.endsWith('.txt') && !filename.endsWith('.md')) {
      return safeEditReply(interaction, {
        content: '❌ Invalid file type: Only `.txt` and `.md` UTF-8 specification attachments are supported.',
        allowedMentions: safeMentions
      }, { type: 'job_error' });
    }

    if (attachment.size > config.maxAttachmentBytes) {
      return safeEditReply(interaction, {
        content: `❌ File too large (${Math.round(attachment.size / 1024)}KB). Maximum allowed size is ${Math.round(config.maxAttachmentBytes / 1024)}KB.`,
        allowedMentions: safeMentions
      }, { type: 'job_error' });
    }

    const fileRes = await fetch(attachment.url);
    if (!fileRes.ok) {
      return safeEditReply(interaction, {
        content: '❌ Failed to download prompt attachment from Discord.',
        allowedMentions: safeMentions
      }, { type: 'job_error' });
    }

    const buf = await fileRes.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.includes(0)) {
      return safeEditReply(interaction, {
        content: '❌ Attachment contains invalid binary or null bytes.',
        allowedMentions: safeMentions
      }, { type: 'job_error' });
    }

    const fileContent = Buffer.from(buf).toString('utf8');
    prompt = prompt ? `${prompt}\n\n${fileContent}` : fileContent;
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
    '`/code chat prompt:<text> [session:<id>] [model:<model>]`',
    'Start or continue a standalone conversation without selecting a project.',
    '',
    '`/code session title:<text> [project:<name>] [model:<model>]`',
    'Create a standalone session or project-linked session.',
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
  handleAutocomplete
};
