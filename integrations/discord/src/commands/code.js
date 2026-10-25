import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder
} from 'discord.js';
import apiClient from '../api-client.js';
import auth from '../authorization.js';
import persistence from '../persistence.js';
import config from '../config.js';
import {
  formatJobCard,
  formatTaskCard,
  formatAuditReport,
  formatFinalReport,
  redactSensitive,
  safeMentions
} from '../notifications.js';

export const data = new SlashCommandBuilder()
  .setName('code')
  .setDescription('CodeOrchestrator management and execution')
  .setDMPermission(false)
  .addSubcommand(sub =>
    sub
      .setName('projects')
      .setDescription('List available projects accessible to you')
  )
  .addSubcommand(sub =>
    sub
      .setName('run')
      .setDescription('Submit a simple coding task')
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
      .setDescription('Submit a multi-agent coding job')
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
      .setDescription('Display available commands and usage guide')
  );

export async function handleAutocomplete(interaction) {
  try {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name === 'project') {
      const authCheck = auth.validateInteraction(interaction);
      if (!authCheck.allowed) {
        return interaction.respond([]);
      }

      const userId = interaction.user?.id || interaction.userId;
      const memberRoles = interaction.member?.roles?.cache
        ? Array.from(interaction.member.roles.cache.keys())
        : Array.isArray(interaction.member?.roles)
        ? interaction.member.roles
        : [];

      const projects = await apiClient.fetchProjects().catch(() => []);
      const query = (focusedOption.value || '').toLowerCase();

      const allowedProjects = projects.filter(p =>
        auth.isProjectAllowedForUser(userId, memberRoles, p)
      );

      const filtered = allowedProjects.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.slug.toLowerCase().includes(query) ||
        p.id.toLowerCase().includes(query)
      );

      const choices = filtered.slice(0, 25).map(p => ({
        name: `${p.name} (${p.slug})`.slice(0, 100),
        value: p.id
      }));

      await interaction.respond(choices);
    }
  } catch {
    try {
      await interaction.respond([]);
    } catch {}
  }
}

export async function execute(interaction, eventListener = null) {
  const subcommand = interaction.options.getSubcommand();

  // Security Gate
  const authCheck = auth.validateInteraction(interaction, subcommand);
  if (!authCheck.allowed) {
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({
        content: `❌ **Access Denied**: ${authCheck.reason}`,
        allowedMentions: safeMentions
      });
    }
    return interaction.reply({
      content: `❌ **Access Denied**: ${authCheck.reason}`,
      ephemeral: true,
      allowedMentions: safeMentions
    });
  }

  // Acknowledge promptly (defer reply)
  await interaction.deferReply();

  const userId = interaction.user?.id || interaction.userId;
  const memberRoles = interaction.member?.roles?.cache
    ? Array.from(interaction.member.roles.cache.keys())
    : Array.isArray(interaction.member?.roles)
    ? interaction.member.roles
    : [];

  try {
    switch (subcommand) {
      case 'projects':
        return await handleProjects(interaction, userId, memberRoles);
      case 'run':
        return await handleRun(interaction, userId, memberRoles, eventListener);
      case 'job':
        return await handleJob(interaction, userId, memberRoles, eventListener);
      case 'status':
        return await handleStatus(interaction);
      case 'audit':
        return await handleAudit(interaction);
      case 'report':
        return await handleReport(interaction);
      case 'cancel':
        return await handleCancel(interaction, userId, memberRoles);
      case 'help':
        return await handleHelp(interaction);
      default:
        return await interaction.editReply({
          content: 'Unknown subcommand.',
          allowedMentions: safeMentions
        });
    }
  } catch (err) {
    return await interaction.editReply({
      content: redactSensitive(`❌ **Error**: ${err.message}`),
      allowedMentions: safeMentions
    });
  }
}

async function handleProjects(interaction, userId, memberRoles) {
  const projects = await apiClient.fetchProjects();
  const accessible = projects.filter(p => auth.isProjectAllowedForUser(userId, memberRoles, p));

  if (accessible.length === 0) {
    return interaction.editReply({
      content: 'No projects found or you lack permission to view available projects.',
      allowedMentions: safeMentions
    });
  }

  const lines = [
    '```',
    'CodeOrchestrator — Accessible Projects',
    ''
  ];

  for (const p of accessible) {
    lines.push(`• Name:   ${p.name}`);
    lines.push(`  ID:     ${p.id}`);
    lines.push(`  Slug:   ${p.slug}`);
    lines.push(`  Model:  ${p.default_model || 'default'}`);
    lines.push('');
  }
  lines.push('```');

  return interaction.editReply({
    content: redactSensitive(lines.join('\n')),
    allowedMentions: safeMentions
  });
}

async function handleRun(interaction, userId, memberRoles, eventListener) {
  const projectInput = interaction.options.getString('project', true);
  const prompt = interaction.options.getString('prompt', true);

  // Validate and resolve project
  const project = await apiClient.resolveProject(projectInput);
  if (!project) {
    return interaction.editReply({
      content: `❌ Project \`${projectInput}\` not found in CodeOrchestrator.`,
      allowedMentions: safeMentions
    });
  }

  // Authorization check for project
  if (!auth.isProjectAllowedForUser(userId, memberRoles, project)) {
    return interaction.editReply({
      content: `❌ Access Denied: You do not have permission to execute tasks on project \`${project.slug}\`.`,
      allowedMentions: safeMentions
    });
  }

  // Create Task via REST API
  const taskRes = await apiClient.createTask(project.id, { prompt });
  const taskId = taskRes.id;
  const initialStatus = taskRes.status || 'queued';

  // Format initial message
  const initialContent = formatTaskCard(
    { id: taskId, project_slug: project.slug, status: initialStatus, prompt },
    { projectSlug: project.slug }
  );

  const trackingNote = `\n_Track with:_ \`/code status id:${taskId}\` _or cancel with:_ \`/code cancel id:${taskId}\``;

  const reply = await interaction.editReply({
    content: `${initialContent}\n${trackingNote}`,
    allowedMentions: safeMentions
  });

  // Persist execution mapping
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
    return interaction.editReply({
      content: '❌ You must provide either a `prompt` or an `attachment` containing the job specification.',
      allowedMentions: safeMentions
    });
  }

  // Validate and read attachment if provided
  if (attachment) {
    const filename = attachment.name.toLowerCase();
    if (!filename.endsWith('.txt') && !filename.endsWith('.md')) {
      return interaction.editReply({
        content: '❌ Invalid file type: Only `.txt` and `.md` UTF-8 specification attachments are supported.',
        allowedMentions: safeMentions
      });
    }

    if (attachment.size > config.maxAttachmentBytes) {
      return interaction.editReply({
        content: `❌ File too large (${Math.round(attachment.size / 1024)}KB). Maximum allowed size is ${Math.round(config.maxAttachmentBytes / 1024)}KB.`,
        allowedMentions: safeMentions
      });
    }

    // Download attachment safely
    const fileRes = await fetch(attachment.url);
    if (!fileRes.ok) {
      return interaction.editReply({
        content: '❌ Failed to download prompt attachment from Discord.',
        allowedMentions: safeMentions
      });
    }

    const buf = await fileRes.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // Null byte check for safety
    if (bytes.includes(0)) {
      return interaction.editReply({
        content: '❌ Attachment contains invalid binary or null bytes.',
        allowedMentions: safeMentions
      });
    }

    const fileContent = Buffer.from(buf).toString('utf8');
    prompt = prompt ? `${prompt}\n\n${fileContent}` : fileContent;
  }

  // Validate and resolve project
  const project = await apiClient.resolveProject(projectInput);
  if (!project) {
    return interaction.editReply({
      content: `❌ Project \`${projectInput}\` not found in CodeOrchestrator.`,
      allowedMentions: safeMentions
    });
  }

  // Authorization check for project
  if (!auth.isProjectAllowedForUser(userId, memberRoles, project)) {
    return interaction.editReply({
      content: `❌ Access Denied: You do not have permission to execute jobs on project \`${project.slug}\`.`,
      allowedMentions: safeMentions
    });
  }

  // Create Multi-Agent Job via REST API
  const jobRes = await apiClient.createJob(project.id, prompt);
  const jobId = jobRes.id;

  // Retrieve job details to obtain requirement count
  let jobDetails = await apiClient.getJob(jobId).catch(() => null);
  const totalReq = jobDetails?.total_requirements || 0;
  const initialStatus = jobDetails?.status || 'queued';

  const initialContent = formatJobCard(
    { id: jobId, project_slug: project.slug, status: initialStatus, total_requirements: totalReq, verified_requirements: 0 },
    { projectSlug: project.slug }
  );

  const trackingNote = `\n_Track with:_ \`/code status id:${jobId}\` _or cancel with:_ \`/code cancel id:${jobId}\``;

  const reply = await interaction.editReply({
    content: `${initialContent}\n${trackingNote}`,
    allowedMentions: safeMentions
  });

  // Persist execution mapping
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

async function handleStatus(interaction) {
  const id = interaction.options.getString('id', true).trim();

  // Try checking Job first
  const job = await apiClient.getJob(id).catch(() => null);
  if (job) {
    const agents = await apiClient.getJobAgents(id).catch(() => null);
    const content = formatJobCard(job, { agents });
    return interaction.editReply({
      content,
      allowedMentions: safeMentions
    });
  }

  // Check Task
  const task = await apiClient.getTask(id).catch(() => null);
  if (task) {
    const content = formatTaskCard(task);
    return interaction.editReply({
      content,
      allowedMentions: safeMentions
    });
  }

  return interaction.editReply({
    content: `❌ No task or job found with ID \`${id}\`.`,
    allowedMentions: safeMentions
  });
}

async function handleAudit(interaction) {
  const id = interaction.options.getString('id', true).trim();

  // 1. Check if ID is a subtask
  const audits = await apiClient.getSubtaskAudits(id).catch(() => null);
  if (audits && audits.length > 0) {
    const content = formatAuditReport(audits, id);
    return interaction.editReply({
      content,
      allowedMentions: safeMentions
    });
  }

  // 2. Check if ID is a job; if so, fetch subtasks and check audits
  const subtasks = await apiClient.getJobSubtasks(id).catch(() => null);
  if (subtasks && subtasks.length > 0) {
    const allAudits = [];
    for (const st of subtasks) {
      const stAudits = await apiClient.getSubtaskAudits(st.id).catch(() => []);
      if (stAudits.length > 0) allAudits.push(...stAudits);
    }
    if (allAudits.length > 0) {
      const content = formatAuditReport(allAudits, `Job ${id}`);
      return interaction.editReply({
        content,
        allowedMentions: safeMentions
      });
    }
  }

  return interaction.editReply({
    content: `❌ No audit records found for subtask or job \`${id}\`.`,
    allowedMentions: safeMentions
  });
}

async function handleReport(interaction) {
  const id = interaction.options.getString('id', true).trim();

  const job = await apiClient.getJob(id).catch(() => null);
  if (job) {
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

    return interaction.editReply(replyPayload);
  }

  const task = await apiClient.getTask(id).catch(() => null);
  if (task) {
    const formatted = formatFinalReport(task, task);
    return interaction.editReply({
      content: formatted.content,
      allowedMentions: safeMentions
    });
  }

  return interaction.editReply({
    content: `❌ No task or job found for report ID \`${id}\`.`,
    allowedMentions: safeMentions
  });
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

    return interaction.editReply({
      content: `⚠️ **Explicit Confirmation Required**\nAre you sure you want to cancel active execution \`${id}\`?\n\nClick below or run: \`/code cancel id:${id} confirm:True\``,
      components: [row],
      allowedMentions: safeMentions
    });
  }

  // Idempotent cancellation: try Job, then Task
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
          return interaction.editReply({
            content: `❌ Cannot cancel: No active task or job with ID \`${id}\` found.`,
            components: [],
            allowedMentions: safeMentions
          });
        }
        throw taskErr;
      }
    } else {
      throw jobErr;
    }
  }

  // Update persistence
  persistence.updateExecution(id, { status: 'cancelled' });

  return interaction.editReply({
    content: `🛑 Execution \`${id}\` (${kind}) has been cancelled. Status: \`${cancelResult.status || 'cancelled'}\`.`,
    components: [],
    allowedMentions: safeMentions
  });
}

async function handleHelp(interaction) {
  const helpText = [
    '**CodeOrchestrator Discord Commands**',
    '',
    '`/code projects`',
    'List all available and authorized projects.',
    '',
    '`/code run project:<name> prompt:<text>`',
    'Submit a single coding task to the execution queue.',
    '',
    '`/code job project:<name> [prompt:<text>] [attachment:<file>]`',
    'Submit a multi-agent coding job with automated workers, auditors, and integration. Supports `.txt` and `.md` files.',
    '',
    '`/code status id:<id>`',
    'Retrieve current execution status and active agent counts.',
    '',
    '`/code audit id:<id>`',
    'Retrieve independent audit findings, verdicts, and verification evidence.',
    '',
    '`/code report id:<id>`',
    'View the final execution report and test results.',
    '',
    '`/code cancel id:<id> [confirm:True]`',
    'Cancel an active task or job (requires explicit confirmation).'
  ].join('\n');

  return interaction.editReply({
    content: helpText,
    allowedMentions: safeMentions
  });
}

export default {
  data,
  execute,
  handleAutocomplete
};
