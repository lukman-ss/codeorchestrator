import { AttachmentBuilder } from 'discord.js';
import { randomUUID } from 'node:crypto';
import {
  DISCORD_LIMITS,
  splitTextIntoChunks,
  redactSensitive,
  formatSpecificationCard,
  formatGitReviewCard
} from './notifications.js';
import {
  downloadAndValidateAttachment,
  savePromptArtifact
} from './attachment-service.js';

// Per-session execution serialization queue
const sessionQueues = new Map();

export async function serializeSession(sessionId, fn) {
  const previous = sessionQueues.get(sessionId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  sessionQueues.set(sessionId, current);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (sessionQueues.get(sessionId) === current) {
      sessionQueues.delete(sessionId);
    }
  }
}

export function cleanPrompt(content, botId) {
  if (!content || typeof content !== 'string') return '';
  const regex = new RegExp(`<@!?${botId}>`, 'g');
  return content.replace(regex, '').trim();
}

export function parseProjectDirective(text) {
  if (!text || typeof text !== 'string') return { projectSlug: null, cleanedText: text || '' };

  const lineRegex = /(?:^|\r?\n)\s*project\s*:\s*([a-zA-Z0-9_.-]+)\s*(?:\r?\n|$)/i;
  const lineMatch = text.match(lineRegex);
  if (lineMatch) {
    const projectSlug = lineMatch[1].trim();
    const cleanedText = text.replace(lineRegex, '\n').trim();
    return { projectSlug, cleanedText };
  }

  const prefixRegex = /^\s*project\s*:\s*([a-zA-Z0-9_.-]+)\s*/i;
  const prefixMatch = text.match(prefixRegex);
  if (prefixMatch) {
    const projectSlug = prefixMatch[1].trim();
    const cleanedText = text.replace(prefixRegex, '').trim();
    return { projectSlug, cleanedText };
  }

  return { projectSlug: null, cleanedText: text };
}

export function extractRepositoryDirective(text) {
  if (!text || typeof text !== 'string') return null;
  const directiveMatch = text.match(/(?:^|\r?\n|\s)(?:(?:git\s+)?remote|repo|repository)\s*[:=]?\s*(\S+)/i);
  if (directiveMatch) {
    const val = directiveMatch[1].trim().replace(/[),.]$/, '');
    if (val.includes('github') || val.includes('.git')) return val;
  }

  const trimmed = text.trim();
  const isStandaloneUrl = /^(https?:\/\/(?:www\.)?github\.com\/\S+|git@(github\.com|github-coding):\S+)$/i.test(trimmed);
  if (isStandaloneUrl) {
    return trimmed.replace(/[),.]$/, '');
  }

  return null;
}

export function extractTaskId(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/(?:task\s*[:=]?\s*|^|\s)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s|$|[),.])/i);
  return match ? match[1].toLowerCase() : null;
}

export function isTaskRecoverable(task) {
  if (!task) return false;
  const isBlocked = task.workflow_status === 'blocked' || task.status === 'blocked' || task.workflow_status === 'interrupted' || task.status === 'interrupted';
  const executionFinished = task.execution_status === 'completed' || task.exit_code === 0;
  return Boolean(isBlocked && executionFinished);
}

export function isGitConfigurationOrResumptionIntent(text, hasRefMessage = false) {
  if (!text || typeof text !== 'string') {
    return Boolean(hasRefMessage);
  }
  const t = text.toLowerCase();
  const hasResumeVerb = /\b(resume|recover|unblock|retry|proceed)\b/i.test(t);
  const hasGitKeywords = /\b(git|remote|origin|repository|repo)\b/i.test(t);
  const hasTaskKeyword = /\b(task|job|workflow)\b/i.test(t) || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t);
  const hasProjectKeyword = /\bproject\s*:/i.test(t);

  if (hasResumeVerb) return true;
  if (/\b(configure|set|add|update)\b.*\b(remote|repo|git)\b/i.test(t)) return true;
  if (/configure_git_and_resume_task/i.test(t)) return true;
  if (hasRefMessage && (Boolean(extractRepositoryDirective(text)) || hasResumeVerb)) return true;
  return false;
}

export async function handleGitConfigurationAndResumption(
  message,
  client,
  apiClient,
  persistence,
  auth,
  { rawPrompt, projectSlug, cleanedPrompt, check, targetProjectId, targetProject, userId }
) {
  const remoteUrl = extractRepositoryDirective(rawPrompt);

  let targetTask = null;
  let resolutionSource = null;

  // Tier 1: Explicit task ID in message text
  const explicitTaskId = extractTaskId(rawPrompt);
  if (explicitTaskId) {
    targetTask = await apiClient.getTask(explicitTaskId).catch(() => null);
    if (!targetTask) {
      return await message.reply({
        content: `❌ **Task Not Found**: Task \`${explicitTaskId}\` does not exist.`,
        allowedMentions: { repliedUser: false, parse: [] }
      });
    }
    resolutionSource = 'explicit_task_id';
  }

  // Tier 2: Referenced message
  if (!targetTask && check?.referencedMessageId) {
    let refTaskId = null;
    const approvalMsg = typeof persistence.getApprovalMessage === 'function'
      ? persistence.getApprovalMessage(check.referencedMessageId)
      : null;
    if (approvalMsg?.approval_id) {
      try {
        const app = await apiClient.getApproval(approvalMsg.approval_id);
        if (app?.task_id) refTaskId = app.task_id;
      } catch {}
    }

    if (!refTaskId && typeof apiClient.getApprovalByDiscordMessage === 'function') {
      try {
        const app = await apiClient.getApprovalByDiscordMessage(check.referencedMessageId);
        if (app?.task_id) refTaskId = app.task_id;
      } catch {}
    }

    if (!refTaskId) {
      const exec = persistence.db?.prepare
        ? persistence.db.prepare("SELECT * FROM discord_executions WHERE message_id = ?").get(check.referencedMessageId)
        : null;
      if (exec?.kind === 'task') {
        refTaskId = exec.id;
      }
    }

    if (!refTaskId) {
      const sub = persistence.db?.prepare
        ? persistence.db.prepare("SELECT * FROM discord_submissions WHERE message_id = ?").get(check.referencedMessageId)
        : null;
      if (sub?.execution_id) {
        refTaskId = sub.execution_id;
      }
    }

    if (!refTaskId) {
      let refText = check.referencedMessageContent || '';
      if (!refText && message.channel?.messages?.fetch) {
        try {
          const fetched = await message.channel.messages.fetch(check.referencedMessageId);
          if (fetched?.content) refText = fetched.content;
        } catch {}
      }
      if (refText) {
        const match = refText.match(/Task:\s*([0-9a-f-]{36})/i);
        if (match) refTaskId = match[1];
      }
    }

    if (!refTaskId) {
      const refMsg = persistence.getSessionMessage(check.referencedMessageId);
      if (refMsg?.session_id) {
        try {
          const st = await apiClient.findRecoverableTask({ sessionId: refMsg.session_id });
          if (st) {
            targetTask = st;
            resolutionSource = 'referenced_session';
          }
        } catch {}
      }
    }

    if (refTaskId && !targetTask) {
      targetTask = await apiClient.getTask(refTaskId).catch(() => null);
      if (targetTask) resolutionSource = 'referenced_message';
    }
  }

  // Tier 3: Session ID
  let activeSessionId = null;
  if (!targetTask) {
    if (check?.referencedMessageId) {
      const refMsg = persistence.getSessionMessage(check.referencedMessageId);
      if (refMsg?.session_id) activeSessionId = refMsg.session_id;
    }
    if (!activeSessionId) {
      const activeConv = persistence.getActiveConversation({
        guildId: message.guildId,
        channelId: message.channel?.isThread?.() ? message.channel.parentId : message.channelId,
        threadId: message.channel?.isThread?.() ? message.channel.id : null,
        discordUserId: userId,
        ...(targetProjectId ? { projectId: targetProjectId } : {})
      });
      if (activeConv?.session_id) activeSessionId = activeConv.session_id;
    }

    if (activeSessionId) {
      try {
        const sessionTask = await apiClient.findRecoverableTask({ sessionId: activeSessionId });
        if (sessionTask) {
          targetTask = sessionTask;
          resolutionSource = 'session_id';
        }
      } catch {}
    }
  }

  // Tier 4: Explicit project with unambiguous recoverable task
  if (!targetTask) {
    const candidateProjectId = targetProjectId || targetProject?.id;
    if (candidateProjectId || projectSlug) {
      try {
        const projTask = await apiClient.findRecoverableTask({
          projectId: candidateProjectId,
          projectSlug
        });
        if (projTask) {
          targetTask = projTask;
          resolutionSource = 'project_unambiguous';
        }
      } catch (err) {
        if (err.ambiguous || err.message?.includes('Multiple recoverable tasks')) {
          const candidates = err.candidates && Array.isArray(err.candidates)
            ? `\nCandidate Tasks: ${err.candidates.map(c => `\`${c}\``).join(', ')}`
            : '';
          return await message.reply({
            content: `⚠️ **Multiple Recoverable Tasks Found**: Project \`${projectSlug || targetProject?.slug || 'selected'}\` has multiple recoverable tasks. Please specify the task ID explicitly (e.g. \`resume task <task-id>\`).${candidates}`,
            allowedMentions: { repliedUser: false, parse: [] }
          });
        }
      }
    }
  }

  // Fallback: If no task resolved and prompt had resume intent, inform user
  if (!targetTask) {
    return await message.reply({
      content: 'ℹ️ **No Recoverable Task Found**: No blocked or interrupted task awaiting resumption was found in this context. To resume a specific task, provide the task ID (e.g. `resume task <task-id>`).',
      allowedMentions: { repliedUser: false, parse: [] }
    });
  }

  // Check if resolved task is actually in a recoverable state
  if (!isTaskRecoverable(targetTask)) {
    if (targetTask.status === 'completed' || targetTask.workflow_status === 'completed') {
      return await message.reply({
        content: `ℹ️ **Task \`${targetTask.id}\`** has already completed successfully.`,
        allowedMentions: { repliedUser: false, parse: [] }
      });
    }
    if (targetTask.workflow_status === 'awaiting_approval' || targetTask.status === 'awaiting_approval') {
      const revRes = await apiClient.getTaskReview(targetTask.id).catch(() => null);
      if (revRes?.approval && revRes.approval.status === 'pending') {
        const card = formatGitReviewCard(revRes.approval, { review: revRes.review, projectSlug: targetProject?.slug || targetTask.project_slug });
        return await message.reply({ ...card, allowedMentions: { repliedUser: false, parse: [] } });
      }
      return await message.reply({
        content: `ℹ️ **Task \`${targetTask.id}\`** is currently awaiting Git approval.`,
        allowedMentions: { repliedUser: false, parse: [] }
      });
    }
    if (targetTask.execution_status === 'running' || targetTask.status === 'running') {
      return await message.reply({
        content: `⏳ **Task \`${targetTask.id}\`** is currently executing. Current status is \`${targetTask.status}\`.`,
        allowedMentions: { repliedUser: false, parse: [] }
      });
    }
    return await message.reply({
      content: `❌ **Task \`${targetTask.id}\`** is in status \`${targetTask.status}\` (workflow: \`${targetTask.workflow_status || targetTask.status}\`). Not in a recoverable blocked state.`,
      allowedMentions: { repliedUser: false, parse: [] }
    });
  }

  // Resolve target project slug for mismatch check
  let effectiveProject = targetProject;
  if (!effectiveProject && targetTask.project_id) {
    try {
      effectiveProject = await apiClient.getProject(targetTask.project_id);
    } catch {}
  }
  const projSlug = effectiveProject?.slug || projectSlug || targetTask.project_slug || '';

  // Ballo vs CodeOrchestrator safety check
  if (remoteUrl && projSlug && projSlug.toLowerCase().includes('ballo')) {
    if (remoteUrl.toLowerCase().includes('codeorchestrator') || remoteUrl.toLowerCase().includes('coding-orchestrator')) {
      return await message.reply({
        content: `❌ **Repository Mismatch**: Cannot configure codeorchestrator repository (\`${remoteUrl}\`) as remote for Ballo project (\`${projSlug}\`). Execution blocked to protect workspace integrity.`,
        allowedMentions: { repliedUser: false, parse: [] }
      });
    }
  }

  // Configure remote if specified
  if (remoteUrl && targetTask.project_id) {
    try {
      await apiClient.configureGitRemote(targetTask.project_id, {
        repoUrl: remoteUrl,
        defaultBranch: effectiveProject?.default_branch || 'main'
      });
    } catch (err) {
      return await message.reply({
        content: `❌ **Git Remote Configuration Failed**: ${err.message}`,
        allowedMentions: { repliedUser: false, parse: [] }
      });
    }
  }

  // Execute task recovery
  try {
    const recoveryResult = await apiClient.recoverTask(targetTask.id, {
      remoteUrl: remoteUrl || undefined
    });

    const refreshedTask = recoveryResult.task || await apiClient.getTask(targetTask.id).catch(() => targetTask);
    const wfStatus = recoveryResult.workflow_status || refreshedTask.workflow_status;

    if (wfStatus === 'awaiting_approval') {
      let approval = recoveryResult.workflowResult?.approvalRequest;
      let review = recoveryResult.workflowResult?.gitReview;
      try {
        const revRes = await apiClient.getTaskReview(targetTask.id);
        if (revRes?.approval) approval = revRes.approval;
        if (revRes?.review) review = revRes.review;
      } catch {}

      if (approval) {
        const card = formatGitReviewCard(approval, {
          review,
          projectSlug: effectiveProject?.slug || projSlug
        });
        return await message.reply({
          content: `✅ **Task \`${targetTask.id}\` Resumed & Progressed to Gate 3**\n\n${card.content}`,
          components: card.components,
          allowedMentions: { repliedUser: false, parse: [] }
        });
      }

      return await message.reply({
        content: `✅ **Task \`${targetTask.id}\` Recovered**: Implementation verified and security audit passed. Status is now \`AWAITING_APPROVAL\`.`,
        allowedMentions: { repliedUser: false, parse: [] }
      });
    }

    if (wfStatus === 'blocked') {
      const gate = recoveryResult.workflowResult?.gate || 'completion';
      const reason = recoveryResult.workflowResult?.error || refreshedTask.error || 'Completion checks blocked';
      return await message.reply({
        content: `🛑 **Task \`${targetTask.id}\` Resumption Blocked**: Resumed completion workflow blocked at Gate ${gate}: ${reason}`,
        allowedMentions: { repliedUser: false, parse: [] }
      });
    }

    if (wfStatus === 'completed') {
      return await message.reply({
        content: `✅ **Task \`${targetTask.id}\` Completed**: Workflow completed successfully.`,
        allowedMentions: { repliedUser: false, parse: [] }
      });
    }

    return await message.reply({
      content: `ℹ️ **Task \`${targetTask.id}\` Resumed**: Status is \`${refreshedTask.status}\` (workflow: \`${wfStatus}\`).`,
      allowedMentions: { repliedUser: false, parse: [] }
    });
  } catch (err) {
    return await message.reply({
      content: `❌ **Task Recovery Failed**: ${err.message}`,
      allowedMentions: { repliedUser: false, parse: [] }
    });
  }
}

export function checkRepositoryMismatch(specRepo, projectRepo) {
  if (!specRepo || !projectRepo) return { mismatch: false };
  const normSpec = specRepo.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
  const normProject = projectRepo.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
  if (normSpec === normProject) return { mismatch: false };

  const checkSpec = normSpec.match(/(?:github\.com[/:])([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/i);
  const checkProj = normProject.match(/(?:github\.com[/:])([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/i);

  if (checkSpec && checkProj) {
    const match = checkSpec[1].toLowerCase() === checkProj[1].toLowerCase() &&
                  checkSpec[2].toLowerCase() === checkProj[2].toLowerCase();
    return { mismatch: !match, specRepo, projectRepo };
  }

  return { mismatch: normSpec !== normProject, specRepo, projectRepo };
}

export function isChatEligible(message, client) {
  if (!message || !client?.user) {
    return { eligible: false, reason: 'invalid_context' };
  }

  // 1. Ignore bot's own messages
  if (message.author?.id === client.user.id) {
    return { eligible: false, reason: 'self_message' };
  }

  // 2. Ignore other bots and webhooks
  if (message.author?.bot || message.webhookId) {
    return { eligible: false, reason: 'bot_or_webhook' };
  }

  // 3. DMs unsupported
  if (!message.guildId) {
    return { eligible: false, reason: 'dm_unsupported' };
  }

  const botId = client.user.id;

  // Check mention
  const isMention = Boolean(
    (message.mentions?.users && message.mentions.users.has(botId)) ||
    (message.mentions?.has && message.mentions.has(botId))
  );

  // Check reply
  const hasReference = Boolean(message.reference?.messageId);
  let isBotReply = false;
  const referencedMessageId = message.reference?.messageId || null;

  if (hasReference && message.referencedMessage) {
    if (message.referencedMessage.author?.id === botId) {
      isBotReply = true;
    }
  }

  // Check thread mode
  const isThread = Boolean(typeof message.channel?.isThread === 'function' && message.channel.isThread());

  if (!isMention && !isBotReply && !isThread && !hasReference) {
    return { eligible: false, reason: 'no_trigger' };
  }

  return {
    eligible: isMention || isBotReply || hasReference || isThread,
    isMention,
    isBotReply,
    isThread,
    referencedMessageId
  };
}

export async function handleMessage(message, client, apiClient, persistence, auth) {
  if (!message || message.author?.bot || message.webhookId || !message.guildId) return null;
  if (client?.user && message.author?.id === client.user.id) return null;

  // Active multipart prompt collection check
  const activeMp = persistence.getActiveMultipartPrompt({
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id
  });

  if (activeMp && (!message.content || !message.content.startsWith('/'))) {
    const memberRoles = message.member?.roles?.cache
      ? Array.from(message.member.roles.cache.keys())
      : Array.isArray(message.member?.roles) ? message.member.roles : [];

    if (!auth.isGuildAllowed(message.guildId) || !auth.isChannelAllowed(message.channelId) || !auth.isUserAllowed(message.author.id, memberRoles)) {
      return null;
    }

    let chunkText = '';
    const attachments = message.attachments ? Array.from(message.attachments.values()) : [];
    if (attachments.length > 0) {
      try {
        const downloaded = await downloadAndValidateAttachment(attachments[0]);
        chunkText = message.content ? `${message.content.trim()}\n\n${downloaded.content}` : downloaded.content;
      } catch (err) {
        return await message.reply({
          content: `❌ **Attachment Error**: ${err.message}`,
          allowedMentions: { repliedUser: false, parse: [] }
        });
      }
    } else {
      chunkText = message.content?.trim();
    }

    if (!chunkText) return null;

    persistence.addMultipartChunk({
      id: randomUUID(),
      multipartPromptId: activeMp.id,
      chunkIndex: activeMp.total_chunks,
      discordMessageId: message.id,
      content: chunkText
    });

    try {
      if (typeof message.react === 'function') {
        await message.react('📝').catch(() => {});
      }
    } catch {}

    return { chunkAdded: true, chunkIndex: activeMp.total_chunks };
  }

  // Check eligibility
  const check = isChatEligible(message, client);
  if (!check.eligible) return null;

  // If message has reference and author not pre-resolved, check if referenced message was authored by bot
  if (check.referencedMessageId && !check.isBotReply) {
    const existingBotMsg = persistence.getSessionMessage(check.referencedMessageId);
    if (existingBotMsg && existingBotMsg.message_role === 'assistant') {
      check.isBotReply = true;
    } else if (message.channel?.messages?.fetch) {
      try {
        const ref = await message.channel.messages.fetch(check.referencedMessageId);
        if (ref?.author?.id === client.user.id) {
          check.isBotReply = true;
        }
      } catch {}
    }
  }

  // If it is a reply to another user's message (not the bot) and NOT mentioning the bot: ignore
  if (check.referencedMessageId && !check.isBotReply && !check.isMention) {
    return null;
  }

  // If inside a thread without mention or reply, only proceed if thread has an active session
  if (!check.isMention && !check.isBotReply && check.isThread) {
    const activeThreadConv = persistence.getActiveConversation({
      guildId: message.guildId,
      channelId: message.channel.parentId || message.channel.id,
      threadId: message.channel.id,
      discordUserId: message.author.id
    });
    if (!activeThreadConv) {
      return null;
    }
  }

  const memberRoles = message.member?.roles?.cache
    ? Array.from(message.member.roles.cache.keys())
    : Array.isArray(message.member?.roles)
    ? message.member.roles
    : [];

  const userId = message.author.id;

  // Authorization enforcement
  if (!auth.isGuildAllowed(message.guildId)) {
    return null;
  }

  if (!auth.isChannelAllowed(message.channelId)) {
    if (check.isMention) {
      await message.reply({
        content: '❌ **Access Denied**: Commands and natural chat are not permitted in this channel.',
        allowedMentions: { repliedUser: false, parse: [] }
      }).catch(() => {});
    }
    return null;
  }

  if (!auth.hasBotPermissions(message)) {
    return null;
  }

  if (!auth.isUserAllowed(userId, memberRoles)) {
    if (check.isMention || check.isBotReply) {
      await message.reply({
        content: '❌ **Access Denied**: You are not authorized to use CodeOrchestrator.',
        allowedMentions: { repliedUser: false, parse: [] }
      }).catch(() => {});
    }
    return null;
  }

  // Idempotency: avoid double-processing redelivered events
  const existingRecord = persistence.getSessionMessage(message.id);
  if (existingRecord && (existingRecord.status === 'completed' || existingRecord.status === 'running')) {
    return null;
  }

  const rawPrompt = cleanPrompt(message.content, client.user.id);
  const attachments = message.attachments ? Array.from(message.attachments.values()) : [];

  // Attachment specification handling
  if (attachments.length > 0) {
    let downloaded;
    try {
      downloaded = await downloadAndValidateAttachment(attachments[0]);
    } catch (err) {
      return await message.reply({
        content: `❌ **Attachment Error**: ${err.message}`,
        allowedMentions: { repliedUser: false, parse: [] }
      });
    }

    const combinedText = rawPrompt ? `${rawPrompt}\n\n${downloaded.content}` : downloaded.content;
    const { projectSlug, cleanedText: fullPrompt } = parseProjectDirective(combinedText);

    let targetSessionId = null;
    let targetConversationId = null;
    let targetProjectId = null;
    let targetProject = null;

    if (projectSlug) {
      targetProject = await apiClient.resolveProject(projectSlug);
      if (!targetProject) {
        return await message.reply({
          content: `❌ **Unknown Project**: Project \`${projectSlug}\` not found. Please verify the project name or slug.`,
          allowedMentions: { repliedUser: false, parse: [] }
        });
      }
      targetProjectId = targetProject.id;
    }

    const specRepo = extractRepositoryDirective(fullPrompt);
    if (targetProject && specRepo && (targetProject.repo_url || targetProject.repository_url)) {
      const repoCheck = checkRepositoryMismatch(specRepo, targetProject.repo_url || targetProject.repository_url);
      if (repoCheck.mismatch) {
        return await message.reply({
          content: `❌ **Repository Mismatch**: Specification repository (\`${specRepo}\`) does not match registered project repository (\`${targetProject.repo_url || targetProject.repository_url}\`). Execution blocked to protect workspace integrity.`,
          allowedMentions: { repliedUser: false, parse: [] }
        });
      }
    }

    if (targetProjectId) {
      const projectConv = persistence.getActiveConversation({
        guildId: message.guildId,
        channelId: message.channel?.isThread?.() ? message.channel.parentId : message.channelId,
        threadId: message.channel?.isThread?.() ? message.channel.id : null,
        discordUserId: userId,
        projectId: targetProjectId
      });
      if (projectConv) {
        targetSessionId = projectConv.session_id;
        targetConversationId = projectConv.id;
      }
    } else {
      if (check.referencedMessageId) {
        const refRecord = persistence.getSessionMessage(check.referencedMessageId);
        if (refRecord) {
          targetSessionId = refRecord.session_id;
          targetConversationId = refRecord.conversation_id;
          const conv = persistence.getConversation(refRecord.conversation_id);
          if (conv?.project_id) {
            targetProjectId = conv.project_id;
            try { targetProject = await apiClient.getProject(targetProjectId); } catch {}
          }
        }
      }

      if (!targetSessionId) {
        const activeConv = persistence.getActiveConversation({
          guildId: message.guildId,
          channelId: message.channel?.isThread?.() ? message.channel.parentId : message.channelId,
          threadId: message.channel?.isThread?.() ? message.channel.id : null,
          discordUserId: userId
        });
        if (activeConv) {
          targetSessionId = activeConv.session_id;
          targetConversationId = activeConv.id;
          targetProjectId = activeConv.project_id;
          if (targetProjectId) {
            try { targetProject = await apiClient.getProject(targetProjectId); } catch {}
          }
        }
      }

      if (targetProject && specRepo && (targetProject.repo_url || targetProject.repository_url)) {
        const repoCheck = checkRepositoryMismatch(specRepo, targetProject.repo_url || targetProject.repository_url);
        if (repoCheck.mismatch) {
          return await message.reply({
            content: `❌ **Repository Mismatch**: Specification repository (\`${specRepo}\`) does not match registered project repository (\`${targetProject.repo_url || targetProject.repository_url}\`). Execution blocked to protect workspace integrity.`,
            allowedMentions: { repliedUser: false, parse: [] }
          });
        }
      }
    }

    const artifact = savePromptArtifact(fullPrompt, attachments[0].name || 'specification.txt');

    const subId = randomUUID();
    const submission = persistence.saveSubmission({
      id: subId,
      guildId: message.guildId,
      channelId: message.channelId,
      userId,
      submissionType: 'attachment',
      inputMethod: check.referencedMessageId ? 'reply_with_attachment' : 'mention_with_attachment',
      sessionId: targetSessionId,
      projectId: targetProjectId,
      promptHash: artifact.sha256,
      promptLength: artifact.sizeBytes,
      artifactPath: artifact.artifactPath,
      status: 'received',
      metadata: {
        filename: downloaded.filename
      }
    });

    const card = formatSpecificationCard(submission, {
      filename: downloaded.filename,
      projectSlug: targetProject?.slug || ''
    });

    const cardMsg = await message.reply({
      content: card.content,
      components: card.components,
      allowedMentions: { repliedUser: false, parse: [] }
    });

    if (cardMsg?.id) {
      persistence.updateSubmission(subId, { messageId: cardMsg.id });
    }
    return cardMsg;
  }

  const { projectSlug, cleanedText: prompt } = parseProjectDirective(rawPrompt);

  // Mention-only message: return helpful greeting
  if (!rawPrompt && check.isMention && !check.referencedMessageId) {
    return await message.reply({
      content: "👋 Hello! I'm Agent Coding. Ask me anything about programming or your code, or reply to any of my messages to continue our conversation.",
      allowedMentions: { repliedUser: false, parse: [] }
    });
  }

  // Missing message content (intent issue)
  if (!rawPrompt && (check.isBotReply || check.referencedMessageId)) {
    return await message.reply({
      content: '⚠️ Unable to read message content. Please ensure `Message Content Intent` is enabled in Discord Developer Portal (Bot → Privileged Gateway Intents) and bot permissions are granted.',
      allowedMentions: { repliedUser: false, parse: [] }
    });
  }

  let targetProjectId = null;
  let targetProject = null;

  if (projectSlug) {
    targetProject = await apiClient.resolveProject(projectSlug);
    if (!targetProject) {
      return await message.reply({
        content: `❌ **Unknown Project**: Project \`${projectSlug}\` not found. Please verify the project name or slug.`,
        allowedMentions: { repliedUser: false, parse: [] }
      });
    }
    targetProjectId = targetProject.id;
  }

  // Repository mismatch check
  const specRepo = extractRepositoryDirective(rawPrompt);
  if (targetProject && specRepo && (targetProject.repo_url || targetProject.repository_url)) {
    const repoCheck = checkRepositoryMismatch(specRepo, targetProject.repo_url || targetProject.repository_url);
    if (repoCheck.mismatch) {
      return await message.reply({
        content: `❌ **Repository Mismatch**: Specification repository (\`${specRepo}\`) does not match registered project repository (\`${targetProject.repo_url || targetProject.repository_url}\`). Execution blocked to protect workspace integrity.`,
        allowedMentions: { repliedUser: false, parse: [] }
      });
    }
  }

  // CONFIGURE_GIT_AND_RESUME_TASK intent routing
  if (isGitConfigurationOrResumptionIntent(rawPrompt, Boolean(check.referencedMessageId))) {
    const handled = await handleGitConfigurationAndResumption(message, client, apiClient, persistence, auth, {
      rawPrompt,
      projectSlug,
      cleanedPrompt: prompt,
      check,
      targetProjectId,
      targetProject,
      userId
    });
    if (handled) return handled;
  }

  if (!prompt && !targetProjectId) return null;

  if (!prompt && targetProject) {
    let projectConv = persistence.getActiveConversation({
      guildId: message.guildId,
      channelId: message.channel?.isThread?.() ? message.channel.parentId : message.channelId,
      threadId: message.channel?.isThread?.() ? message.channel.id : null,
      discordUserId: userId,
      projectId: targetProjectId
    });
    if (!projectConv) {
      const session = await apiClient.createSession({
        title: `Project ${targetProject.slug}`,
        type: 'project',
        projectId: targetProjectId,
        userId
      });
      projectConv = persistence.createConversation({
        id: randomUUID(),
        guildId: message.guildId,
        channelId: message.channel?.isThread?.() ? message.channel.parentId : message.channelId,
        threadId: message.channel?.isThread?.() ? message.channel.id : null,
        discordUserId: userId,
        sessionId: session.id,
        projectId: targetProjectId,
        conversationType: 'project',
        status: 'active'
      });
    }
    return await message.reply({
      content: `📁 Switched active project context to \`${targetProject.slug}\`. How can I help you with this project?`,
      allowedMentions: { repliedUser: false, parse: [] }
    });
  }

  // Conversation & Session Resolution
  let targetSessionId = null;
  let targetConversationId = null;
  const conversationScope = {
    guildId: message.guildId,
    channelId: message.channel?.isThread?.() ? message.channel.parentId : message.channelId,
    threadId: message.channel?.isThread?.() ? message.channel.id : null,
    discordUserId: userId
  };

  if (targetProjectId) {
    let projectConv = persistence.getActiveConversation({
      ...conversationScope,
      projectId: targetProjectId
    });
    let session = null;

    if (projectConv) {
      try {
        session = await apiClient.getSession(projectConv.session_id);
        if (session.status === 'closed') {
          session = null;
        }
      } catch {
        session = null;
      }
    }

    if (!session) {
      session = await apiClient.createSession({
        title: prompt.slice(0, 50).trim() || `Project ${targetProject.slug}`,
        type: 'project',
        projectId: targetProjectId,
        userId
      });

      const convId = randomUUID();
      projectConv = persistence.createConversation({
        id: convId,
        guildId: conversationScope.guildId,
        channelId: conversationScope.channelId,
        threadId: conversationScope.threadId,
        discordUserId: userId,
        sessionId: session.id,
        projectId: targetProjectId,
        conversationType: 'project',
        status: 'active'
      });
    }

    targetSessionId = session.id;
    targetConversationId = projectConv.id;
  } else if (check.referencedMessageId) {
    const refRecord = persistence.getSessionMessage(check.referencedMessageId);
    if (refRecord) {
      let session;
      try {
        session = await apiClient.getSession(refRecord.session_id);
      } catch (err) {
        return await message.reply({
          content: `⚠️ The associated session could not be retrieved from CodeOrchestrator (${err.message}). Mention @Agent Coding to start a new conversation.`,
          allowedMentions: { repliedUser: false, parse: [] }
        });
      }

      if (session.status === 'closed') {
        return await message.reply({
          content: '⚠️ This session has been closed. Mention @Agent Coding or use `/code session new` to start a new conversation.',
          allowedMentions: { repliedUser: false, parse: [] }
        });
      }

      // Check session privacy and ownership
      if (!auth.isSessionAllowedForUser(userId, memberRoles, session)) {
        return await message.reply({
          content: '❌ **Access Denied**: You cannot continue another user\'s private conversation. Start your own conversation by mentioning @Agent Coding.',
          allowedMentions: { repliedUser: false, parse: [] }
        });
      }

      targetSessionId = session.id;
      targetConversationId = refRecord.conversation_id;
    } else {
      let approval = null;
      let review = null;

      // 1. Check if referenced message is an approval card message directly in bridge persistence
      const approvalMsg = typeof persistence.getApprovalMessage === 'function'
        ? persistence.getApprovalMessage(check.referencedMessageId)
        : null;

      if (approvalMsg?.approval_id) {
        try {
          approval = await apiClient.getApproval(approvalMsg.approval_id);
          if (approval?.task_id) {
            const revRes = await apiClient.getTaskReview(approval.task_id).catch(() => null);
            review = revRes?.review || null;
          } else if (approval?.job_id) {
            const revRes = await apiClient.getJobReview(approval.job_id).catch(() => null);
            review = revRes?.review || null;
          }
        } catch {}
      }

      // 2. Check if referenced message matches orchestrator approval discord_message_id
      if (!approval && typeof apiClient.getApprovalByDiscordMessage === 'function') {
        try {
          approval = await apiClient.getApprovalByDiscordMessage(check.referencedMessageId);
          if (approval?.task_id) {
            const revRes = await apiClient.getTaskReview(approval.task_id).catch(() => null);
            review = revRes?.review || null;
          } else if (approval?.job_id) {
            const revRes = await apiClient.getJobReview(approval.job_id).catch(() => null);
            review = revRes?.review || null;
          }
        } catch {}
      }

      // 3. Check execution tracking for task or job notification card
      const execution = persistence.db?.prepare
        ? persistence.db.prepare("SELECT * FROM discord_executions WHERE message_id = ?").get(check.referencedMessageId)
        : null;

      if (!approval && execution && execution.kind !== 'session') {
        try {
          const revRes = execution.kind === 'job'
            ? await apiClient.getJobReview(execution.id).catch(() => null)
            : await apiClient.getTaskReview(execution.id).catch(() => null);
          approval = revRes?.approval || null;
          review = revRes?.review || null;
        } catch {}
      }

      // If approval request exists (either from card or task notification), route to review card with buttons
      if (approval) {
        if (approval.status === 'pending') {
          const card = formatGitReviewCard(approval, { review });
          return await message.reply({
            ...card,
            allowedMentions: { repliedUser: false, parse: [] }
          });
        }
        return await message.reply({
          content: `ℹ️ **Approval \`${approval.id}\`** has already been decided (\`${approval.status}\`${approval.decision ? `: ${approval.decision}` : ''}).`,
          allowedMentions: { repliedUser: false, parse: [] }
        });
      }

      if (execution && execution.kind !== 'session') {
        if (['awaiting_approval', 'verifying', 'auditing', 'git_review', 'running', 'queued'].includes(execution.status)) {
          return await message.reply({
            content: `⏳ **${execution.kind === 'job' ? 'Job' : 'Task'} in Progress**: Current status is \`${execution.status}\`. The Git review card with approval buttons will be posted once verification and security checks pass.`,
            allowedMentions: { repliedUser: false, parse: [] }
          });
        }
        if (execution.status === 'completed') {
          return await message.reply({
            content: `ℹ️ **${execution.kind === 'job' ? 'Job' : 'Task'} \`${execution.id}\`** has already completed. Changes are committed/preserved; no pending Git approval required.`,
            allowedMentions: { repliedUser: false, parse: [] }
          });
        }
        if (execution.status === 'blocked') {
          return await message.reply({
            content: `❌ **${execution.kind === 'job' ? 'Job' : 'Task'} \`${execution.id}\`** was blocked during completion checks. No changes can be pushed.`,
            allowedMentions: { repliedUser: false, parse: [] }
          });
        }
        if (execution.status === 'failed') {
          return await message.reply({
            content: `❌ **${execution.kind === 'job' ? 'Job' : 'Task'} \`${execution.id}\`** failed during execution.`,
            allowedMentions: { repliedUser: false, parse: [] }
          });
        }
        return await message.reply({
          content: `ℹ️ **${execution.kind === 'job' ? 'Job' : 'Task'} \`${execution.id}\`** is in status \`${execution.status}\`.`,
          allowedMentions: { repliedUser: false, parse: [] }
        });
      }

      // 4. Fallback: Parse Task ID or Job ID directly from referenced message if available
      let refText = check.referencedMessageContent || '';
      if (!execution && !approval && message.channel?.messages?.fetch) {
        try {
          const fetched = await message.channel.messages.fetch(check.referencedMessageId);
          if (fetched?.content) refText = fetched.content;
        } catch {}
      }
      if (!execution && !approval && refText) {
        const tMatch = refText.match(/Task:\s*([a-f0-9\-]+)/i);
        const jMatch = refText.match(/Job:\s*([a-f0-9\-]+)/i);
        const refTaskId = tMatch ? tMatch[1] : null;
        const refJobId = jMatch ? jMatch[1] : null;
        if (refTaskId) {
          try {
            const revRes = await apiClient.getTaskReview(refTaskId).catch(() => null);
            approval = revRes?.approval || null;
            review = revRes?.review || null;
            if (approval) {
              if (approval.status === 'pending') {
                const card = formatGitReviewCard(approval, { review });
                return await message.reply({ ...card, allowedMentions: { repliedUser: false, parse: [] } });
              }
              return await message.reply({
                content: `ℹ️ **Approval \`${approval.id}\`** has already been decided (\`${approval.status}\`${approval.decision ? `: ${approval.decision}` : ''}).`,
                allowedMentions: { repliedUser: false, parse: [] }
              });
            }
            const taskObj = await apiClient.getTask(refTaskId).catch(() => null);
            if (taskObj) {
              return await message.reply({
                content: `ℹ️ **Task \`${taskObj.id}\`** is in status \`${taskObj.status}\` (workflow: \`${taskObj.workflow_status || taskObj.status}\`). No pending Git approval required.`,
                allowedMentions: { repliedUser: false, parse: [] }
              });
            }
          } catch {}
        } else if (refJobId) {
          try {
            const revRes = await apiClient.getJobReview(refJobId).catch(() => null);
            approval = revRes?.approval || null;
            review = revRes?.review || null;
            if (approval) {
              if (approval.status === 'pending') {
                const card = formatGitReviewCard(approval, { review });
                return await message.reply({ ...card, allowedMentions: { repliedUser: false, parse: [] } });
              }
              return await message.reply({
                content: `ℹ️ **Approval \`${approval.id}\`** has already been decided (\`${approval.status}\`${approval.decision ? `: ${approval.decision}` : ''}).`,
                allowedMentions: { repliedUser: false, parse: [] }
              });
            }
            const jobObj = await apiClient.getJob(refJobId).catch(() => null);
            if (jobObj) {
              return await message.reply({
                content: `ℹ️ **Job \`${jobObj.id}\`** is in status \`${jobObj.status}\` (workflow: \`${jobObj.workflow_status || jobObj.status}\`). No pending Git approval required.`,
                allowedMentions: { repliedUser: false, parse: [] }
              });
            }
          } catch {}
        }
      }

      if (!check.isMention) {
        return await message.reply({
          content: "⚠️ I couldn't find an active conversation session for that message. Mention @Agent Coding or use `/code chat` to start a new conversation.",
          allowedMentions: { repliedUser: false, parse: [] }
        });
      }
    }
  }

  // 2. Active conversation in scope or new standalone session
  if (!targetSessionId) {
    let activeConv = persistence.getActiveConversation(conversationScope);
    let session = null;

    if (activeConv) {
      try {
        session = await apiClient.getSession(activeConv.session_id);
        if (session.status === 'closed') {
          session = null;
        }
      } catch {
        session = null;
      }
    }

    if (!session) {
      session = await apiClient.createSession({
        title: prompt.slice(0, 50).trim(),
        type: 'standalone',
        userId
      });

      const convId = randomUUID();
      activeConv = persistence.createConversation({
        id: convId,
        guildId: conversationScope.guildId,
        channelId: conversationScope.channelId,
        threadId: conversationScope.threadId,
        discordUserId: userId,
        sessionId: session.id,
        conversationType: 'standalone',
        status: 'active'
      });
    }

    targetSessionId = session.id;
    targetConversationId = activeConv.id;
  }

  // Persist incoming message state (running)
  persistence.saveSessionMessage({
    id: randomUUID(),
    conversationId: targetConversationId,
    sessionId: targetSessionId,
    discordMessageId: message.id,
    referencedMessageId: check.referencedMessageId,
    messageRole: 'user',
    status: 'running'
  });

  // Typing indicator
  let typingInterval = null;
  try {
    if (typeof message.channel?.sendTyping === 'function') {
      await message.channel.sendTyping().catch(() => {});
      typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 8000);
    }
  } catch {}

  try {
    const result = await serializeSession(targetSessionId, async () => {
      return await apiClient.sendSessionMessage(targetSessionId, {
        prompt,
        userId
      });
    });

    if (typingInterval) clearInterval(typingInterval);

    const responseText = result?.response?.trim() || '_(No response returned)_';
    const sanitized = redactSensitive(responseText);
    const chunks = splitTextIntoChunks(sanitized, DISCORD_LIMITS.SAFE_MESSAGE_LENGTH);

    if (chunks.length <= 3) {
      // Chunk 0: reply to triggering message
      const replyMsg = await message.reply({
        content: chunks[0],
        allowedMentions: { repliedUser: false, parse: [] }
      });

      persistence.saveSessionMessage({
        id: randomUUID(),
        conversationId: targetConversationId,
        sessionId: targetSessionId,
        discordMessageId: replyMsg.id,
        referencedMessageId: message.id,
        messageRole: 'assistant',
        status: 'completed'
      });

      // Subsequent chunks: channel.send
      for (let i = 1; i < chunks.length; i++) {
        const nextMsg = await message.channel.send({
          content: chunks[i],
          allowedMentions: { repliedUser: false, parse: [] }
        });
        persistence.saveSessionMessage({
          id: randomUUID(),
          conversationId: targetConversationId,
          sessionId: targetSessionId,
          discordMessageId: nextMsg.id,
          referencedMessageId: message.id,
          messageRole: 'assistant',
          status: 'completed'
        });
      }
    } else {
      // Very long responses: concise summary + attachment
      const attachment = new AttachmentBuilder(Buffer.from(sanitized, 'utf8'), {
        name: 'response.txt',
        description: 'Complete OpenCode Response'
      });

      const replyMsg = await message.reply({
        content: chunks[0] + '\n\n*(Full response attached)*',
        files: [attachment],
        allowedMentions: { repliedUser: false, parse: [] }
      });

      persistence.saveSessionMessage({
        id: randomUUID(),
        conversationId: targetConversationId,
        sessionId: targetSessionId,
        discordMessageId: replyMsg.id,
        referencedMessageId: message.id,
        messageRole: 'assistant',
        status: 'completed'
      });
    }

    persistence.updateSessionMessage(message.id, { status: 'completed' });
    persistence.updateConversation(targetConversationId, {
      last_activity_at: new Date().toISOString()
    });

    return result;
  } catch (err) {
    if (typingInterval) clearInterval(typingInterval);

    persistence.updateSessionMessage(message.id, {
      status: 'failed',
      error: err.message
    });

    await message.reply({
      content: redactSensitive(`❌ **Error**: ${err.message}`),
      allowedMentions: { repliedUser: false, parse: [] }
    }).catch(() => {});

    return null;
  }
}
