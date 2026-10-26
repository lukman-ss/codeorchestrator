import { AttachmentBuilder } from 'discord.js';

export const DISCORD_LIMITS = {
  MAX_MESSAGE_LENGTH: 2000,
  SAFE_MESSAGE_LENGTH: 1900,
  MAX_EMBEDS: 10,
  MAX_EMBED_TITLE: 256,
  MAX_EMBED_DESCRIPTION: 4096,
  MAX_EMBED_FIELDS: 25,
  MAX_FIELD_NAME: 256,
  MAX_FIELD_VALUE: 1024,
  MAX_EMBED_FOOTER: 2048,
  MAX_EMBED_AUTHOR: 256,
  MAX_EMBED_TOTAL: 6000,
  MAX_CHUNKS_BEFORE_ATTACHMENT: 3
};

export const safeMentions = { parse: [] };

export const redactSensitive = (input) => {
  if (typeof input !== 'string') {
    if (!input) return '';
    input = JSON.stringify(input, null, 2);
  }
  let sanitized = input;

  sanitized = sanitized.replace(/(?:NINEROUTER_API_KEY|ORCHESTRATOR_API_TOKEN|DISCORD_BOT_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|PRIVATE_KEY|SECRET_KEY|API_KEY)[=:][\s"']*([a-zA-Z0-9_\-\.]{8,})[\s"']*/gi, (m, k) => m.replace(k, '[REDACTED]'));
  sanitized = sanitized.replace(/Bearer\s+([a-zA-Z0-9_\-\.]{15,})/gi, 'Bearer [REDACTED]');
  sanitized = sanitized.replace(/sk-[a-zA-Z0-9_\-]{20,}/gi, 'sk-[REDACTED]');
  sanitized = sanitized.replace(/ghp_[a-zA-Z0-9]{36}/gi, 'ghp_[REDACTED]');
  sanitized = sanitized.replace(/github_pat_[a-zA-Z0-9_]{50,}/gi, 'github_pat_[REDACTED]');
  sanitized = sanitized.replace(/xox[baprs]-[0-9a-zA-Z]{10,48}/gi, '[REDACTED_SLACK_TOKEN]');
  sanitized = sanitized.replace(/ey[A-Za-z0-9_-]{15,}\.ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/gi, '[REDACTED_JWT]');
  sanitized = sanitized.replace(/[MN][A-Za-z\d]{23,27}\.[\w-]{6}\.[\w-]{27,38}/g, '[REDACTED_DISCORD_TOKEN]');
  sanitized = sanitized.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]');
  sanitized = sanitized.replace(/(postgres|mysql|sqlite|mongodb):\/\/([^:]+):([^@]+)@/gi, '$1://$2:[REDACTED]@');
  sanitized = sanitized.replace(/(100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/g, '[REDACTED_IP]');
  sanitized = sanitized.replace(/\/home\/[a-zA-Z0-9_\-]+/g, '~');

  const envTokens = [process.env.DISCORD_BOT_TOKEN, process.env.ORCHESTRATOR_API_TOKEN].filter(Boolean);
  for (const token of envTokens) {
    if (token.length >= 8 && sanitized.includes(token)) {
      sanitized = sanitized.replaceAll(token, '[REDACTED]');
    }
  }

  return sanitized;
};

export function recordOversizedMessage(length, type = 'unknown') {
  console.warn(`[DiscordBridge] Oversized message detected: length=${length}, type=${type}`);
}

export function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xD800 && codeUnit <= 0xDBFF;
}

export function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF;
}

export function splitTextIntoChunks(text, maxChunkSize = DISCORD_LIMITS.SAFE_MESSAGE_LENGTH) {
  if (typeof text !== 'string') text = String(text || '');
  if (text.length <= maxChunkSize) return [text];

  const chunks = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      let finalChunk = remaining;
      if (inCodeBlock) {
        finalChunk = `\`\`\`${codeBlockLang}\n` + finalChunk;
      }
      chunks.push(finalChunk);
      break;
    }

    const reserveMargin = 30;
    const targetLimit = Math.max(100, maxChunkSize - reserveMargin);

    let splitIndex = Math.min(targetLimit, remaining.length);

    if (splitIndex < remaining.length && isHighSurrogate(remaining.charCodeAt(splitIndex - 1))) {
      splitIndex -= 1;
    }

    const searchWindow = Math.max(0, splitIndex - 300);
    const lastNewline = remaining.lastIndexOf('\n', splitIndex);
    if (lastNewline >= searchWindow) {
      splitIndex = lastNewline + 1;
    } else {
      const lastSpace = remaining.lastIndexOf(' ', splitIndex);
      if (lastSpace >= Math.max(0, splitIndex - 150)) {
        splitIndex = lastSpace + 1;
      }
    }

    if (splitIndex < remaining.length && isHighSurrogate(remaining.charCodeAt(splitIndex - 1))) {
      splitIndex -= 1;
    }

    let chunk = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex);

    let prefix = '';
    if (inCodeBlock) {
      prefix = `\`\`\`${codeBlockLang}\n`;
    }

    const testChunk = prefix + chunk;
    const backtickMatches = testChunk.match(/```([a-zA-Z0-9_-]*)/g);
    const count = backtickMatches ? backtickMatches.length : 0;
    let suffix = '';
    if (count % 2 === 1) {
      inCodeBlock = true;
      const lastMatch = backtickMatches[backtickMatches.length - 1];
      codeBlockLang = lastMatch.replace('```', '').trim();
      suffix = '\n```';
    } else {
      inCodeBlock = false;
      codeBlockLang = '';
    }

    chunks.push(prefix + chunk + suffix);
  }

  return chunks;
}

export function validateEmbed(embed) {
  if (!embed || typeof embed !== 'object') return embed;
  const sanitizedEmbed = { ...embed };
  let totalLength = 0;

  if (sanitizedEmbed.title) {
    let t = redactSensitive(String(sanitizedEmbed.title));
    if (t.length > DISCORD_LIMITS.MAX_EMBED_TITLE) {
      recordOversizedMessage(t.length, 'embed_title');
      t = t.slice(0, DISCORD_LIMITS.MAX_EMBED_TITLE - 3) + '...';
    }
    sanitizedEmbed.title = t;
    totalLength += t.length;
  }

  if (sanitizedEmbed.description) {
    let d = redactSensitive(String(sanitizedEmbed.description));
    if (d.length > DISCORD_LIMITS.MAX_EMBED_DESCRIPTION) {
      recordOversizedMessage(d.length, 'embed_description');
      d = d.slice(0, DISCORD_LIMITS.MAX_EMBED_DESCRIPTION - 3) + '...';
    }
    sanitizedEmbed.description = d;
    totalLength += d.length;
  }

  if (Array.isArray(sanitizedEmbed.fields)) {
    const validFields = [];
    for (let f of sanitizedEmbed.fields.slice(0, DISCORD_LIMITS.MAX_EMBED_FIELDS)) {
      if (!f || typeof f !== 'object') continue;
      let name = redactSensitive(String(f.name || ''));
      let value = redactSensitive(String(f.value || ''));

      if (name.length > DISCORD_LIMITS.MAX_FIELD_NAME) {
        recordOversizedMessage(name.length, 'embed_field_name');
        name = name.slice(0, DISCORD_LIMITS.MAX_FIELD_NAME - 3) + '...';
      }
      if (value.length > DISCORD_LIMITS.MAX_FIELD_VALUE) {
        recordOversizedMessage(value.length, 'embed_field_value');
        value = value.slice(0, DISCORD_LIMITS.MAX_FIELD_VALUE - 3) + '...';
      }

      totalLength += name.length + value.length;
      validFields.push({ ...f, name, value });
    }
    sanitizedEmbed.fields = validFields;
  }

  if (sanitizedEmbed.footer?.text) {
    let fText = redactSensitive(String(sanitizedEmbed.footer.text));
    if (fText.length > DISCORD_LIMITS.MAX_EMBED_FOOTER) {
      recordOversizedMessage(fText.length, 'embed_footer');
      fText = fText.slice(0, DISCORD_LIMITS.MAX_EMBED_FOOTER - 3) + '...';
    }
    sanitizedEmbed.footer = { ...sanitizedEmbed.footer, text: fText };
    totalLength += fText.length;
  }

  if (sanitizedEmbed.author?.name) {
    let aName = redactSensitive(String(sanitizedEmbed.author.name));
    if (aName.length > DISCORD_LIMITS.MAX_EMBED_AUTHOR) {
      recordOversizedMessage(aName.length, 'embed_author');
      aName = aName.slice(0, DISCORD_LIMITS.MAX_EMBED_AUTHOR - 3) + '...';
    }
    sanitizedEmbed.author = { ...sanitizedEmbed.author, name: aName };
    totalLength += aName.length;
  }

  if (totalLength > DISCORD_LIMITS.MAX_EMBED_TOTAL) {
    recordOversizedMessage(totalLength, 'embed_total');
    const overflow = totalLength - DISCORD_LIMITS.MAX_EMBED_TOTAL;
    if (sanitizedEmbed.description && sanitizedEmbed.description.length > overflow + 10) {
      sanitizedEmbed.description = sanitizedEmbed.description.slice(0, -overflow - 10) + '... (truncated)';
    } else if (Array.isArray(sanitizedEmbed.fields) && sanitizedEmbed.fields.length > 1) {
      sanitizedEmbed.fields = sanitizedEmbed.fields.slice(0, Math.max(1, sanitizedEmbed.fields.length - 2));
    }
  }

  return sanitizedEmbed;
}

export function validateEmbeds(embeds) {
  if (!Array.isArray(embeds)) return [];
  if (embeds.length > DISCORD_LIMITS.MAX_EMBEDS) {
    recordOversizedMessage(embeds.length, 'embed_count');
  }
  return embeds.slice(0, DISCORD_LIMITS.MAX_EMBEDS).map(validateEmbed);
}

export function formatDiscordPayload(rawPayload, {
  type = 'message',
  maxChunks = DISCORD_LIMITS.MAX_CHUNKS_BEFORE_ATTACHMENT,
  attachmentFilename = null,
  forceSingle = false
} = {}) {
  let payload = typeof rawPayload === 'string' ? { content: rawPayload } : { ...rawPayload };

  payload.allowedMentions = safeMentions;

  if (payload.embeds) {
    payload.embeds = validateEmbeds(payload.embeds);
  }

  const rawContent = payload.content != null ? String(payload.content) : '';
  const sanitizedContent = redactSensitive(rawContent);

  if (sanitizedContent.length <= DISCORD_LIMITS.MAX_MESSAGE_LENGTH) {
    return {
      primaryPayload: { ...payload, content: sanitizedContent },
      followUpPayloads: []
    };
  }

  recordOversizedMessage(sanitizedContent.length, type);

  if (forceSingle) {
    let truncated = sanitizedContent.slice(0, DISCORD_LIMITS.SAFE_MESSAGE_LENGTH - 40);
    if (isHighSurrogate(truncated.charCodeAt(truncated.length - 1))) {
      truncated = truncated.slice(0, -1);
    }
    const backticks = (truncated.match(/```/g) || []).length;
    if (backticks % 2 === 1) {
      truncated += '\n```';
    }
    truncated += '\n*(truncated)*';
    return {
      primaryPayload: { ...payload, content: truncated },
      followUpPayloads: []
    };
  }

  const isReportOrLargeDoc = ['report', 'job_report', 'task_report', 'audit', 'projects'].includes(type);
  const chunks = splitTextIntoChunks(sanitizedContent, DISCORD_LIMITS.SAFE_MESSAGE_LENGTH);

  if (isReportOrLargeDoc || chunks.length > maxChunks) {
    const filename = attachmentFilename || `${type}-${Date.now()}.txt`;
    const attachment = new AttachmentBuilder(Buffer.from(sanitizedContent, 'utf8'), { name: filename });
    const existingFiles = Array.isArray(payload.files) ? payload.files : [];

    let summaryText;
    const firstNewline = sanitizedContent.indexOf('\n\n');
    if (firstNewline !== -1 && firstNewline < 500) {
      summaryText = sanitizedContent.slice(0, firstNewline);
    } else {
      summaryText = sanitizedContent.slice(0, 400);
    }
    if (isHighSurrogate(summaryText.charCodeAt(summaryText.length - 1))) {
      summaryText = summaryText.slice(0, -1);
    }
    const backticks = (summaryText.match(/```/g) || []).length;
    if (backticks % 2 === 1) {
      summaryText += '\n```';
    }

    const summaryContent = `${summaryText}\n\n📄 _Output exceeds Discord message limits (${sanitizedContent.length} chars). Full details attached as \`${filename}\`._`;

    return {
      primaryPayload: {
        ...payload,
        content: summaryContent,
        files: [...existingFiles, attachment]
      },
      followUpPayloads: []
    };
  }

  const primaryPayload = { ...payload, content: chunks[0] };
  const followUpPayloads = chunks.slice(1).map(chunk => ({
    content: chunk,
    allowedMentions: safeMentions
  }));

  return { primaryPayload, followUpPayloads };
}

export function formatErrorPayload(err, { type = 'error', ephemeral = false } = {}) {
  const rawMsg = (err && typeof err === 'object' ? err.message || err.statusText || String(err) : String(err)) || 'Unknown error';
  const sanitized = redactSensitive(rawMsg);
  const prefix = '❌ **Error**: ';
  const maxMsgLen = 1800;

  if (sanitized.length > maxMsgLen) {
    recordOversizedMessage(sanitized.length, type);
  }

  const truncated = sanitized.length > maxMsgLen
    ? sanitized.slice(0, maxMsgLen) + '... (truncated)'
    : sanitized;

  return {
    content: `${prefix}${truncated}`,
    ephemeral,
    allowedMentions: safeMentions
  };
}

export async function safeEditReply(interaction, rawPayload, options = {}) {
  const { primaryPayload, followUpPayloads } = formatDiscordPayload(rawPayload, options);
  let res;
  try {
    res = await interaction.editReply(primaryPayload);
  } catch (err) {
    console.error(`[DiscordBridge] editReply failed: ${err.message}`);
    try {
      res = await interaction.editReply({
        content: '❌ Error: Failed to render response.',
        allowedMentions: safeMentions
      });
    } catch {}
    return res;
  }

  for (const followUp of followUpPayloads) {
    try {
      if (typeof interaction.followUp === 'function') {
        await interaction.followUp(followUp);
      }
    } catch (err) {
      console.warn(`[DiscordBridge] followUp failed: ${err.message}`);
    }
  }

  return res;
}

export async function safeReply(interaction, rawPayload, options = {}) {
  if (interaction.deferred || interaction.replied) {
    return safeEditReply(interaction, rawPayload, options);
  }

  const { primaryPayload, followUpPayloads } = formatDiscordPayload(rawPayload, options);
  let res;
  try {
    res = await interaction.reply(primaryPayload);
  } catch (err) {
    console.error(`[DiscordBridge] reply failed: ${err.message}`);
    try {
      res = await interaction.reply({
        content: '❌ Error: Failed to render response.',
        ephemeral: true,
        allowedMentions: safeMentions
      });
    } catch {}
    return res;
  }

  for (const followUp of followUpPayloads) {
    try {
      if (typeof interaction.followUp === 'function') {
        await interaction.followUp(followUp);
      }
    } catch (err) {
      console.warn(`[DiscordBridge] followUp failed: ${err.message}`);
    }
  }

  return res;
}

export async function safeChannelSend(channel, rawPayload, options = {}) {
  if (!channel || typeof channel.send !== 'function') return null;

  const { primaryPayload, followUpPayloads } = formatDiscordPayload(rawPayload, options);
  let msg;
  try {
    msg = await channel.send(primaryPayload);
  } catch (err) {
    console.error(`[DiscordBridge] channel.send failed: ${err.message}`);
    try {
      msg = await channel.send({
        content: '❌ Error: Notification exceeds limit or failed to render.',
        allowedMentions: safeMentions
      });
    } catch {}
    return msg;
  }

  for (const followUp of followUpPayloads) {
    try {
      await channel.send(followUp);
    } catch (err) {
      console.warn(`[DiscordBridge] channel.send followUp failed: ${err.message}`);
    }
  }

  return msg;
}

export async function safeMessageEdit(message, rawPayload, options = {}) {
  if (!message || typeof message.edit !== 'function') return null;

  const { primaryPayload } = formatDiscordPayload(rawPayload, { ...options, forceSingle: true });
  try {
    return await message.edit(primaryPayload);
  } catch (err) {
    console.error(`[DiscordBridge] message.edit failed: ${err.message}`);
    try {
      return await message.edit({
        content: '⚠️ Progress card update failed.',
        allowedMentions: safeMentions
      });
    } catch {}
    return null;
  }
}

export default {
  DISCORD_LIMITS,
  safeMentions,
  redactSensitive,
  recordOversizedMessage,
  splitTextIntoChunks,
  validateEmbed,
  validateEmbeds,
  formatDiscordPayload,
  formatErrorPayload,
  safeEditReply,
  safeReply,
  safeChannelSend,
  safeMessageEdit
};
