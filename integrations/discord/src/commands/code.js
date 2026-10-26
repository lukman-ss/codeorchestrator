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
  safeMentions,
  safeEditReply,
  safeReply,
  formatErrorPayload
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
    return safeReply(interaction, {
      content: `❌ **Access Denied**: ${authCheck.reason}`,
      ephemeral: true,
      allowedMentions: safeMentions
    }, { type: 'auth_denied' });
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

async function handleProjects(interaction, userId, memberRoles) {
  const projects = await apiClient.fetchProjects();
  const accessible = projects.filter(p => auth.isProjectAllowedForUser(userId, memberRoles, p));

  if (accessible.length === 0) {
    return safeEditReply(interaction, {
      content: 'No projects found or you lack permission to view available projects.',
      allowedMentions: safeMentions
    }, { type: 'projects' });
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

  const fullText = redactSensitive(lines.join('\n'));

  // If projects list is oversized, create concise summary + txt attachment
  if (fullText.length > 1800) {
    const summaryLines = [
      '```',
      `CodeOrchestrator — Accessible Projects (${accessible.length} projects)`,
      ''
    ];
    for (const p of accessible.slice(0, 5)) {
      summaryLines.push(`• ${p.name} (${p.slug})`);
    }
    if (accessible.length > 5) {
      summaryLines.push(`... and ${accessible.length - 5} more projects`);
    }
    summaryLines.push('```');
    summaryLines.push('_Full project list attached below._');

    return safeEditReply(interaction, {
      content: summaryLines.join('\n'),
      files: [
        new AttachmentBuilder(Buffer.from(fullText, 'utf8'), { name: 'projects.txt' })
      ],
      allowedMentions: safeMentions
    }, { type: 'projects' });
  }

  return safeEditReply(interaction, {
    content: fullText,
    allowedMentions: safeMentions
  }, { type: 'projects' });
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

  // 1. Check if ID is a subtask
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

  // 2. Check if ID is a job; if so, fetch subtasks and check audits
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
