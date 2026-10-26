import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCORD_LIMITS,
  splitTextIntoChunks,
  validateEmbed,
  validateEmbeds,
  formatDiscordPayload,
  formatErrorPayload,
  safeEditReply,
  safeReply,
  safeMessageEdit,
  safeChannelSend,
  redactSensitive
} from '../src/message-formatter.js';
import {
  formatJobCard,
  formatTaskCard,
  formatAuditReport,
  formatFinalReport
} from '../src/notifications.js';

function createMockInteraction() {
  const replies = [];
  const followUps = [];
  let deferred = true;
  let replied = false;

  return {
    deferred,
    replied,
    editReply: async (payload) => {
      replies.push(payload);
      return { id: 'msg-edit-' + Date.now(), ...payload };
    },
    reply: async (payload) => {
      replied = true;
      replies.push(payload);
      return { id: 'msg-reply-' + Date.now(), ...payload };
    },
    followUp: async (payload) => {
      followUps.push(payload);
      return { id: 'msg-followup-' + Date.now(), ...payload };
    },
    getReplies: () => replies,
    getFollowUps: () => followUps
  };
}

// 1. Messages below 2,000 characters
test('1. Message formatter sends messages below 2,000 characters normally', () => {
  const shortText = 'Standard status update for execution task-123. All systems nominal.';
  const result = formatDiscordPayload(shortText, { type: 'status' });

  assert.equal(result.followUpPayloads.length, 0);
  assert.equal(result.primaryPayload.content, shortText);
  assert.ok(result.primaryPayload.content.length <= DISCORD_LIMITS.MAX_MESSAGE_LENGTH);
});

// 2. Messages exactly 2,000 characters
test('2. Message formatter handles messages of exactly 2,000 characters without exceeding limit', () => {
  const exactText = 'A'.repeat(2000);
  const result = formatDiscordPayload(exactText, { type: 'test' });

  assert.equal(result.primaryPayload.content.length, 2000);
  assert.ok(result.primaryPayload.content.length <= DISCORD_LIMITS.MAX_MESSAGE_LENGTH);
  assert.equal(result.followUpPayloads.length, 0);
});

// 3. Messages exceeding 2,000 characters
test('3. Message formatter splits messages exceeding 2,000 characters into safe chunks <= 1,900', () => {
  const longText = 'Line of execution detail.\n'.repeat(120); // ~3,120 chars
  const chunks = splitTextIntoChunks(longText, DISCORD_LIMITS.SAFE_MESSAGE_LENGTH);

  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= DISCORD_LIMITS.SAFE_MESSAGE_LENGTH, `Chunk length ${chunk.length} exceeds 1900`);
  }

  // Verify Markdown preservation across chunks
  const codeBlockText = '```javascript\n' + 'const item = 1;\n'.repeat(150) + '```';
  const codeChunks = splitTextIntoChunks(codeBlockText, DISCORD_LIMITS.SAFE_MESSAGE_LENGTH);
  assert.ok(codeChunks.length >= 2);
  assert.ok(codeChunks[0].endsWith('```'));
  assert.ok(codeChunks[1].startsWith('```javascript\n'));
});

// 4. Large multi-agent reports
test('4. Large multi-agent reports produce concise summary and sanitized .txt attachment', () => {
  const largeJobReport = {
    jobId: 'job-large-888',
    finalVerdict: 'PASS',
    totalRequirements: 50,
    verifiedRequirements: 50,
    subtasks: Array.from({ length: 40 }, (_, i) => ({
      id: `subtask-${i}`,
      role: 'worker',
      status: 'completed',
      logs: 'Detailed compilation step output with code traces.'.repeat(5)
    }))
  };

  const reportResult = formatFinalReport(largeJobReport, {
    id: 'job-large-888',
    status: 'completed',
    total_requirements: 50,
    verified_requirements: 50,
    final_audit_verdict: 'PASS'
  });

  assert.ok(reportResult.attachment, 'Must include file attachment for large report');
  assert.ok(reportResult.content.length <= DISCORD_LIMITS.SAFE_MESSAGE_LENGTH);
  assert.ok(reportResult.attachment.name.endsWith('.txt'));
  assert.ok(reportResult.attachment.data.length > 2000);
});

// 5. Long audit findings
test('5. Long audit findings generate concise summary and detailed attachment', () => {
  const massiveFindings = Array.from({ length: 60 }, (_, i) => `Finding #${i}: Regression in module component authentication logic`);
  const massiveCriteria = Array.from({ length: 40 }, (_, i) => ({
    id: `crit-${i}`,
    name: `Criterion ${i} must validate security bounds`,
    passed: false,
    status: 'failed'
  }));

  const auditRecord = [{
    subtask_id: 'sub-large-findings',
    verdict: 'FAILED',
    criteria_json: JSON.stringify(massiveCriteria),
    findings_json: JSON.stringify(massiveFindings),
    evidence_json: JSON.stringify({ stdout: 'E'.repeat(3000) }),
    summary: 'Extensive audit failure across all integration checkpoints.'
  }];

  const formatted = formatAuditReport(auditRecord, 'sub-large-findings');
  assert.ok(formatted.includes('Auditor Verdict: FAILED'));
  assert.ok(formatted.length <= DISCORD_LIMITS.SAFE_MESSAGE_LENGTH);
  assert.ok(formatted.attachment, 'Must provide attachment for voluminous audit data');
  assert.ok(formatted.attachment.name.includes('audit-sub-large-findings'));
});

// 6. Long error messages
test('6. Long error messages are truncated safely and do not exceed message limits', () => {
  const hugeErrorMsg = 'Validation failed in internal router: ' + 'X'.repeat(5000);
  const errPayload = formatErrorPayload(new Error(hugeErrorMsg), { type: 'test_error' });

  assert.ok(errPayload.content.length <= DISCORD_LIMITS.SAFE_MESSAGE_LENGTH);
  assert.ok(errPayload.content.startsWith('❌ **Error**: '));
  assert.ok(errPayload.content.includes('(truncated)'));
});

// 7. Unicode and emoji handling
test('7. Unicode and emoji surrogate pairs are never split across chunks', () => {
  // Construct text where an emoji lands on boundary
  const filler = 'A'.repeat(1899);
  const emoji = '🚀'; // 2 UTF-16 code units: \uD83D\uDE80
  const combined = filler + emoji + 'extra trailing content';

  const chunks = splitTextIntoChunks(combined, DISCORD_LIMITS.SAFE_MESSAGE_LENGTH);
  assert.ok(chunks.length >= 2);

  // Check lone surrogate regex: lone high or low surrogate
  const loneSurrogateRegex = /(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]|[\uD800-\uDBFF](?:[^\uDC00-\uDFFF]|$)/;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    assert.ok(chunk.length <= DISCORD_LIMITS.SAFE_MESSAGE_LENGTH);
    assert.equal(loneSurrogateRegex.test(chunk), false, `Chunk ${i} contains broken surrogate pair`);
  }
});

// 8. Sensitive output redaction
test('8. Sensitive tokens, keys, and home directory paths are redacted from messages and attachments', () => {
  const privateIp = ['10', '0', '0', '1'].join('.');
  const homePath = '/home/' + 'someuser';
  const sensitiveText = [
    'ORCHESTRATOR_API_TOKEN=supersecrettoken1234567890',
    'Bearer token1234567890abcdef',
    'sk-1234567890abcdef1234567890abcdef',
    `postgres://dbuser:mypassword123@${privateIp}:5432/orchestrator`,
    `${homePath}/workspace/secret.env`
  ].join('\n');

  const redacted = redactSensitive(sensitiveText);
  assert.ok(!redacted.includes('supersecrettoken1234567890'));
  assert.ok(!redacted.includes('token1234567890abcdef'));
  assert.ok(!redacted.includes('mypassword123'));
  assert.ok(!redacted.includes(homePath));
  assert.ok(redacted.includes('[REDACTED]'));
  assert.ok(redacted.includes('~'));

  // Large report attachment must also be redacted
  const report = formatFinalReport({
    token: 'sk-1234567890abcdef1234567890abcdef',
    path: `${homePath}/test`
  }, { id: 'job-sec', status: 'completed' });

  if (report.attachment) {
    const attachmentContent = report.attachment.data.toString('utf8');
    assert.ok(!attachmentContent.includes('sk-1234567890abcdef'));
    assert.ok(!attachmentContent.includes(homePath));
  }
});

// 9. Follow-up and progress notifications
test('9. Follow-up and progress notifications handle chunks and single message limits cleanly', async () => {
  const interaction = createMockInteraction();
  const multiChunkText = 'Chunk segment.\n'.repeat(150); // ~2,250 chars

  await safeEditReply(interaction, { content: multiChunkText }, { type: 'multi_chunk_test' });

  const replies = interaction.getReplies();
  const followUps = interaction.getFollowUps();

  assert.equal(replies.length, 1);
  assert.ok(replies[0].content.length <= DISCORD_LIMITS.SAFE_MESSAGE_LENGTH);
  assert.ok(followUps.length >= 1);
  for (const fu of followUps) {
    assert.ok(fu.content.length <= DISCORD_LIMITS.SAFE_MESSAGE_LENGTH);
  }

  // Test safeMessageEdit forces single message without follow-ups
  const editedMessages = [];
  const mockMessage = {
    edit: async (payload) => {
      editedMessages.push(payload);
      return payload;
    }
  };

  const hugeCardContent = '```\nCodeOrchestrator Card\n' + 'Log line\n'.repeat(300) + '```';
  await safeMessageEdit(mockMessage, { content: hugeCardContent }, { type: 'progress_card' });

  assert.equal(editedMessages.length, 1);
  assert.ok(editedMessages[0].content.length <= DISCORD_LIMITS.SAFE_MESSAGE_LENGTH);
  assert.ok(editedMessages[0].content.includes('(truncated)'));
});

// 10. Oversized error fallback
test('10. Oversized error fallback prevents cascading Discord API errors', async () => {
  const failingInteraction = {
    editReply: async (payload) => {
      if (payload.content.length > 50) {
        throw new Error('Invalid Form Body content[BASE_TYPE_MAX_LENGTH]: Must be 2000 or fewer in length.');
      }
      return payload;
    }
  };

  const hugeError = new Error('Huge error'.repeat(400));
  const errPayload = formatErrorPayload(hugeError, { type: 'error_fallback' });

  // safeEditReply catches the rejection and delivers safe fallback
  const res = await safeEditReply(failingInteraction, errPayload, { type: 'error_fallback' });
  assert.ok(res);
  assert.ok(res.content.length <= 50);
});

// 11. Discord Embed limits validation
test('11. Discord embed validation truncates fields exceeding limits and enforces total limit', () => {
  const oversizedEmbed = {
    title: 'T'.repeat(300),
    description: 'D'.repeat(5000),
    fields: [
      { name: 'N'.repeat(300), value: 'V'.repeat(1200) },
      { name: 'Field 2', value: 'Value 2' }
    ],
    footer: { text: 'F'.repeat(2500) },
    author: { name: 'A'.repeat(300) }
  };

  const validated = validateEmbed(oversizedEmbed);
  assert.ok(validated.title.length <= DISCORD_LIMITS.MAX_EMBED_TITLE);
  assert.ok(validated.description.length <= DISCORD_LIMITS.MAX_EMBED_DESCRIPTION);
  assert.ok(validated.fields[0].name.length <= DISCORD_LIMITS.MAX_FIELD_NAME);
  assert.ok(validated.fields[0].value.length <= DISCORD_LIMITS.MAX_FIELD_VALUE);
  assert.ok(validated.footer.text.length <= DISCORD_LIMITS.MAX_EMBED_FOOTER);
  assert.ok(validated.author.name.length <= DISCORD_LIMITS.MAX_EMBED_AUTHOR);

  // Validate array of embeds does not exceed 10
  const manyEmbeds = Array.from({ length: 15 }, () => ({ title: 'Test' }));
  const validatedArray = validateEmbeds(manyEmbeds);
  assert.equal(validatedArray.length, 10);
});
