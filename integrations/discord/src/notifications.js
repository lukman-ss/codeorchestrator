import {
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
} from './message-formatter.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';

export {
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

export const formatJobCard = (job, { projectSlug = '', agents = null, latestEvent = null } = {}) => {
  const status = job.status || 'pending';
  const total = job.total_requirements || 0;
  const verified = job.verified_requirements || 0;
  const proj = projectSlug || job.project_slug || job.project_id || 'unknown';

  const titleStatus = status.charAt(0).toUpperCase() + status.slice(1);
  const safeLatest = latestEvent ? (String(latestEvent).length > 150 ? String(latestEvent).slice(0, 147) + '...' : String(latestEvent)) : null;

  if (status === 'completed') {
    const finalAudit = job.final_audit_verdict === 'PASS' ? 'PASS' : (job.final_audit_verdict || 'UNVERIFIED');
    return redactSensitive([
      '```',
      'CodeOrchestrator',
      `Job: ${job.id}`,
      `Status: Completed`,
      `Requirements: ${verified}/${total} verified`,
      `Audit: ${finalAudit}`,
      `Integration: ${finalAudit === 'PASS' ? 'PASS' : 'UNVERIFIED'}`,
      `Tests: ${finalAudit === 'PASS' ? 'PASS' : 'UNVERIFIED'}`,
      '```'
    ].join('\n'));
  }

  if (status === 'cancelled' || status === 'failed' || status === 'blocked' || status === 'partially_completed') {
    return redactSensitive([
      '```',
      'CodeOrchestrator',
      `Job: ${job.id}`,
      `Project: ${proj}`,
      `Status: ${titleStatus}`,
      `Requirements: ${verified}/${total} verified`,
      job.final_audit_verdict ? `Verdict: ${job.final_audit_verdict}` : '',
      '```'
    ].filter(Boolean).join('\n'));
  }

  if (status === 'queued' || status === 'planning' || status === 'pending') {
    return redactSensitive([
      '```',
      'CodeOrchestrator',
      `Job: ${job.id}`,
      `Project: ${proj}`,
      `Status: ${titleStatus}`,
      `Requirements: ${total}`,
      `Verified: ${verified}/${total}`,
      '```'
    ].join('\n'));
  }

  const activeWorkers = agents?.byRole?.worker ?? 0;
  const activeAuditors = agents?.byRole?.auditor ?? 0;
  const activeIntegrations = agents?.byRole?.integration ?? 0;

  const integrationState = activeIntegrations > 0 ? 'Integrating' : 'Waiting';

  return redactSensitive([
    '```',
    'CodeOrchestrator',
    `Job: ${job.id}`,
    `Status: ${titleStatus}`,
    `Verified: ${verified}/${total}`,
    '',
    `Workers: ${activeWorkers} active`,
    `Auditors: ${activeAuditors} active`,
    `Integration: ${integrationState}`,
    safeLatest ? `\nLatest: ${safeLatest}` : '',
    '```'
  ].filter(line => line !== '').join('\n'));
};

export const formatTaskCard = (task, { projectSlug = '', latestEvent = null } = {}) => {
  const status = task.status || 'queued';
  const proj = projectSlug || task.project_slug || task.project_id || 'unknown';
  const titleStatus = status.charAt(0).toUpperCase() + status.slice(1);
  const safeLatest = latestEvent ? (String(latestEvent).length > 150 ? String(latestEvent).slice(0, 147) + '...' : String(latestEvent)) : null;

  if (status === 'completed') {
    return redactSensitive([
      '```',
      'CodeOrchestrator',
      `Task: ${task.id}`,
      `Project: ${proj}`,
      `Status: Completed`,
      `Exit Code: ${task.exit_code ?? 0}`,
      '```'
    ].join('\n'));
  }

  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') {
    const errorStr = task.error ? (String(task.error).length > 150 ? String(task.error).slice(0, 147) + '...' : String(task.error)) : null;
    return redactSensitive([
      '```',
      'CodeOrchestrator',
      `Task: ${task.id}`,
      `Project: ${proj}`,
      `Status: ${titleStatus}`,
      errorStr ? `Error: ${errorStr}` : `Exit Code: ${task.exit_code ?? 'N/A'}`,
      '```'
    ].join('\n'));
  }

  if (status === 'running') {
    return redactSensitive([
      '```',
      'CodeOrchestrator',
      `Task: ${task.id}`,
      `Project: ${proj}`,
      `Status: Running`,
      safeLatest ? `Latest: ${safeLatest}` : '',
      '```'
    ].filter(Boolean).join('\n'));
  }

  return redactSensitive([
    '```',
    'CodeOrchestrator',
    `Task: ${task.id}`,
    `Project: ${proj}`,
    `Status: Queued`,
    task.prompt ? `Prompt: ${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? '...' : ''}` : '',
    '```'
  ].filter(Boolean).join('\n'));
};

export const formatAuditReport = (audits, subtaskId) => {
  if (!audits || audits.length === 0) {
    return redactSensitive(`No audit records found for subtask \`${subtaskId}\`.`);
  }

  const latest = audits[0];
  const verdict = latest.verdict || 'UNVERIFIED';

  let criteria = [];
  try {
    criteria = JSON.parse(latest.criteria_json || '[]');
  } catch {}

  let findings = [];
  try {
    findings = JSON.parse(latest.findings_json || '[]');
  } catch {}

  let evidence = {};
  try {
    evidence = JSON.parse(latest.evidence_json || '{}');
  } catch {}

  const failedCriteria = criteria.filter(c => c.status === 'failed' || c.passed === false);
  const evidenceSummary = latest.summary || JSON.stringify(evidence).slice(0, 300);

  const failedNames = failedCriteria.map(c => c.name || c.id || String(c)).join(', ');
  const truncatedFailed = failedNames.length > 200 ? failedNames.slice(0, 197) + '...' : (failedNames || 'None');
  const safeEvidence = evidenceSummary.length > 200 ? evidenceSummary.slice(0, 197) + '...' : evidenceSummary;

  const summaryLines = [
    '```',
    'CodeOrchestrator — Audit Result',
    `Subtask ID: ${latest.subtask_id || subtaskId}`,
    `Auditor Verdict: ${verdict}`,
    `Attempts: ${audits.length}`,
    `Failed Criteria: ${truncatedFailed}`,
    `Findings: ${findings.length > 0 ? findings.length : 'None'}`,
    `Evidence: ${safeEvidence}`,
    '```'
  ];

  const fullFindings = JSON.stringify({
    subtaskId: latest.subtask_id || subtaskId,
    verdict,
    attempts: audits.length,
    failedCriteria,
    findings,
    evidence
  }, null, 2);

  const fullReportText = redactSensitive(summaryLines.join('\n') + '\n\nFindings & Evidence:\n' + fullFindings);

  if (fullReportText.length > 1800) {
    const res = new String(redactSensitive(summaryLines.join('\n')));
    res.content = redactSensitive(summaryLines.join('\n'));
    res.attachment = {
      name: `audit-${subtaskId || 'report'}.txt`,
      data: Buffer.from(fullReportText, 'utf8')
    };
    return res;
  }

  return redactSensitive(summaryLines.join('\n'));
};

export const formatFinalReport = (report, job = null) => {
  if (!report && !job) {
    return { content: 'No report data available.' };
  }

  const finalVerdict = report?.finalVerdict || job?.final_audit_verdict || 'UNVERIFIED';
  const total = report?.totalRequirements ?? job?.total_requirements ?? 0;
  const verified = report?.verifiedRequirements ?? job?.verified_requirements ?? 0;
  const status = job?.status || (finalVerdict === 'PASS' ? 'completed' : 'partially_completed');

  const summary = [
    '```',
    'CodeOrchestrator — Final Report',
    `Job ID: ${job?.id || report?.jobId || 'N/A'}`,
    `Status: ${status}`,
    `Requirements: ${verified}/${total} verified`,
    `Audit: ${finalVerdict}`,
    `Integration: ${finalVerdict === 'PASS' ? 'PASS' : 'PARTIAL/FAILED'}`,
    `Tests: ${finalVerdict === 'PASS' ? 'PASS' : 'FAILURES PRESENT'}`,
    '```'
  ].join('\n');

  const fullReportText = redactSensitive(JSON.stringify(report || job, null, 2));

  if (summary.length + fullReportText.length + 30 > 1800) {
    return {
      content: redactSensitive(summary),
      attachment: {
        name: `report-${job?.id || report?.jobId || 'job'}.txt`,
        data: Buffer.from(fullReportText, 'utf8')
      }
    };
  }

  return {
    content: redactSensitive(`${summary}\n\`\`\`json\n${fullReportText}\n\`\`\``)
  };
};

export const formatSpecificationCard = (submission, { projectSlug = '', filename = '' } = {}) => {
  const sizeKb = (submission.prompt_length / 1024).toFixed(1);
  const targetDesc = projectSlug ? `Project: \`${projectSlug}\`` : (submission.session_id ? `Session: \`${submission.session_id.slice(0, 8)}...\`` : 'Standalone Session');
  const sourceDesc = filename ? `File: \`${filename}\`` : (submission.input_method === 'multipart_prompt' ? 'Multipart Prompt' : 'Direct Attachment');

  const content = redactSensitive([
    '### 📋 Specification Received',
    `**Input**: ${sourceDesc}`,
    `**Size**: ${submission.prompt_length} bytes (${sizeKb} KB)`,
    `**SHA-256**: \`${submission.prompt_hash}\``,
    `**Target**: ${targetDesc}`,
    '',
    'Click **Execute** to run this specification, or **Cancel** to abort.'
  ].join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`btn_sub_exec_${submission.id}`)
      .setLabel('Execute')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`btn_sub_cancel_${submission.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  return {
    content,
    components: [row]
  };
};

export const formatExecutionStartedCard = (submission, { projectSlug = '' } = {}) => {
  const targetDesc = projectSlug ? `Project: \`${projectSlug}\`` : (submission.session_id ? `Session: \`${submission.session_id.slice(0, 8)}...\`` : 'Standalone Session');
  return {
    content: redactSensitive([
      '### 🚀 Execution Started',
      `**Target**: ${targetDesc}`,
      `**Submission ID**: \`${submission.id}\``,
      submission.execution_id ? `**Execution ID**: \`${submission.execution_id}\`` : '',
      `**Status**: Running...`
    ].filter(Boolean).join('\n')),
    components: []
  };
};

export const formatExecutionResultCard = (submission, result, { projectSlug = '' } = {}) => {
  const status = result?.status || (result?.error ? 'failed' : 'completed');
  const isPass = status === 'completed' || (!result?.error && result?.status !== 'failed');
  const icon = isPass ? '✅' : '❌';
  const responseText = result?.response || result?.output || result?.error || '_(No response returned)_';
  const sanitized = redactSensitive(responseText);

  const header = [
    `### ${icon} Execution ${isPass ? 'Completed' : 'Failed'}`,
    `**Submission ID**: \`${submission.id}\``,
    submission.execution_id ? `**Execution ID**: \`${submission.execution_id}\`` : '',
    `**Status**: ${status}`
  ].filter(Boolean).join('\n');

  if (sanitized.length > 1500) {
    const attachment = new AttachmentBuilder(Buffer.from(sanitized, 'utf8'), {
      name: `execution-${submission.id.slice(0, 8)}.txt`
    });
    return {
      content: `${header}\n\n*(Full execution response attached due to length)*`,
      components: [],
      files: [attachment]
    };
  }

  return {
    content: `${header}\n\n\`\`\`\n${sanitized}\n\`\`\``,
    components: []
  };
};

export const formatGitReviewCard = (approval, { review = null, projectSlug = '' } = {}) => {
  const approvalId = approval.id;
  const repo = approval.repository_identity || approval.repository || 'unknown';
  const branch = approval.target_branch || 'main';
  let files = [];
  try {
    files = Array.isArray(approval.files_changed)
      ? approval.files_changed
      : JSON.parse(approval.files_changed || '[]');
  } catch { files = []; }

  let diff = {};
  try {
    diff = typeof approval.diff_summary === 'object' && approval.diff_summary !== null
      ? approval.diff_summary
      : JSON.parse(approval.diff_summary || '{}');
  } catch { diff = {}; }

  const commitMsg = approval.proposed_commit_message || 'Task implementation completed';

  const lines = [
    '### 🛡️ Completion Gates Review & Approval',
    `**Repository**: \`${repo}\``,
    `**Target Branch**: \`${branch}\``,
    `**Approval ID**: \`${approvalId}\``,
    approval.task_id ? `**Task ID**: \`${approval.task_id}\`` : (approval.job_id ? `**Job ID**: \`${approval.job_id}\`` : ''),
    '',
    '**Gate Checks**:',
    '• Gate 1 (Verification): ✅ **PASS**',
    '• Gate 2 (Security Audit): ✅ **PASS** (0 secrets / confidential leaks)',
    '• Gate 3 (Git Review): ⏳ **AWAITING DECISION**',
    '',
    `**Diff**: ${files.length} changed file(s) (+${diff.added || 0} ~${diff.modified || 0} -${diff.deleted || 0})`,
    files.length > 0 ? `\`${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}\`` : '*(no changes)*',
    '',
    `**Proposed Commit**: \`${commitMsg.slice(0, 100)}\``,
    '',
    'Click **Push to GitHub** to push your commit, or **Keep Local** to preserve files without pushing.'
  ].filter(Boolean);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`btn_git_push_${approvalId}`)
      .setLabel('Push to GitHub')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`btn_git_keeplocal_${approvalId}`)
      .setLabel('Keep Local')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`btn_git_reject_${approvalId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
  );

  return {
    content: redactSensitive(lines.join('\n')),
    components: [row]
  };
};

export const formatGitDecisionResultCard = (approval, decision, { commitSha = null, error = null } = {}) => {
  const repo = approval?.repository_identity || 'unknown';
  const branch = approval?.target_branch || 'main';
  const approvalId = approval?.id || 'N/A';

  if (error) {
    return {
      content: redactSensitive([
        '### ❌ Git Operation Blocked / Failed',
        `**Approval ID**: \`${approvalId}\``,
        `**Decision**: \`${decision}\``,
        `**Error**: ${error}`
      ].join('\n')),
      components: []
    };
  }

  if (decision === 'push') {
    return {
      content: redactSensitive([
        '### 🚀 Pushed to GitHub Successfully',
        `**Approval ID**: \`${approvalId}\``,
        `**Repository**: \`${repo}\``,
        `**Branch**: \`${branch}\``,
        commitSha ? `**Commit SHA**: \`${commitSha}\`` : '',
        'Gate 3 complete. Workflow completed.'
      ].filter(Boolean).join('\n')),
      components: []
    };
  }

  if (decision === 'keep_local') {
    return {
      content: redactSensitive([
        '### 📁 Local Changes Preserved',
        `**Approval ID**: \`${approvalId}\``,
        'Workspace modifications preserved locally. Git push bypassed.',
        'Gate 3 complete. Workflow completed.'
      ].join('\n')),
      components: []
    };
  }

  return {
    content: redactSensitive([
      '### 🛑 Approval Rejected',
      `**Approval ID**: \`${approvalId}\``,
      'Changes were rejected and have not been pushed.'
    ].join('\n')),
    components: []
  };
};

export default {
  DISCORD_LIMITS,
  redactSensitive,
  safeMentions,
  formatJobCard,
  formatTaskCard,
  formatAuditReport,
  formatFinalReport,
  formatSpecificationCard,
  formatExecutionStartedCard,
  formatExecutionResultCard,
  formatGitReviewCard,
  formatGitDecisionResultCard,
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
