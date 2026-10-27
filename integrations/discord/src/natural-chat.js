import { AttachmentBuilder } from 'discord.js';
import { randomUUID } from 'node:crypto';
import {
  DISCORD_LIMITS,
  splitTextIntoChunks,
  redactSensitive,
  formatSpecificationCard
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

  const prompt = cleanPrompt(message.content, client.user.id);
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

    const fullPrompt = prompt ? `${prompt}\n\n${downloaded.content}` : downloaded.content;
    const artifact = savePromptArtifact(fullPrompt, attachments[0].name || 'specification.txt');

    // Resolve target session / project
    let targetSessionId = null;
    let targetConversationId = null;
    let targetProjectId = null;

    if (check.referencedMessageId) {
      const refRecord = persistence.getSessionMessage(check.referencedMessageId);
      if (refRecord) {
        targetSessionId = refRecord.session_id;
        targetConversationId = refRecord.conversation_id;
        const conv = persistence.getConversation(refRecord.conversation_id);
        if (conv?.project_id) targetProjectId = conv.project_id;
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
      }
    }

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
      filename: downloaded.filename
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

  // Mention-only message: return helpful greeting
  if (!prompt && check.isMention && !check.referencedMessageId) {
    return await message.reply({
      content: "👋 Hello! I'm Agent Coding. Ask me anything about programming or your code, or reply to any of my messages to continue our conversation.",
      allowedMentions: { repliedUser: false, parse: [] }
    });
  }

  // Missing message content (intent issue)
  if (!prompt && (check.isBotReply || check.referencedMessageId)) {
    return await message.reply({
      content: '⚠️ Unable to read message content. Please ensure `Message Content Intent` is enabled in Discord Developer Portal (Bot → Privileged Gateway Intents) and bot permissions are granted.',
      allowedMentions: { repliedUser: false, parse: [] }
    });
  }

  if (!prompt) return null;

  // Conversation & Session Resolution
  let targetSessionId = null;
  let targetConversationId = null;
  const conversationScope = {
    guildId: message.guildId,
    channelId: message.channel?.isThread?.() ? message.channel.parentId : message.channelId,
    threadId: message.channel?.isThread?.() ? message.channel.id : null,
    discordUserId: userId
  };

  // 1. Reply to bot message takes precedence
  if (check.referencedMessageId) {
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
      // Check execution tracking for task or job card
      const execution = persistence.db.prepare("SELECT * FROM discord_executions WHERE message_id = ?").get(check.referencedMessageId);
      if (execution && execution.kind !== 'session') {
        return await message.reply({
          content: `⚠️ This message belongs to a ${execution.kind} notification, not an interactive chat session. Mention @Agent Coding or use \`/code chat\` to start a conversation, or \`/code run\` for tasks.`,
          allowedMentions: { repliedUser: false, parse: [] }
        });
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
