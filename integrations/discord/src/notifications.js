// Secret redaction patterns
const SECRET_PATTERNS = [
  // High entropy tokens and keys
  /(?:NINEROUTER_API_KEY|ORCHESTRATOR_API_TOKEN|DISCORD_BOT_TOKEN)[=:][\s"']*([a-zA-Z0-9_\-\.]{10,})[\s"']*/gi,
  /Bearer\s+([a-zA-Z0-9_\-\.]{15,})/gi,
  /sk-[a-zA-Z0-9_\-]{20,}/gi,
  /ghp_[a-zA-Z0-9]{36}/gi,
  /github_pat_[a-zA-Z0-9_]{50,}/gi,
  /xox[baprs]-[0-9a-zA-Z]{10,48}/gi,
  /ey[A-Za-z0-9_-]{15,}\.ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/gi,
  // Discord bot token pattern: [24-28 chars].[6 chars].[27-38 chars]
  /[MN][A-Za-z\d]{23,27}\.[\w-]{6}\.[\w-]{27,38}/g,
  // Private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  // Database passwords in URIs
  /(postgres|mysql|sqlite|mongodb):\/\/[^:\s]+:([^@\s]+)@/gi,
  // Tailscale and RFC1918 internal IPs
  /(100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/g,
  // Specific user home directory paths
  /\/home\/[a-zA-Z0-9_\-]+/g
];

export const redactSensitive = (input) => {
  if (typeof input !== 'string') {
    if (!input) return '';
    input = JSON.stringify(input, null, 2);
  }
  let sanitized = input;

  // Redact known patterns
  sanitized = sanitized.replace(/(?:NINEROUTER_API_KEY|ORCHESTRATOR_API_TOKEN|DISCORD_BOT_TOKEN)[=:][\s"']*([a-zA-Z0-9_\-\.]{10,})[\s"']*/gi, (m, k) => m.replace(k, '[REDACTED]'));
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

  return sanitized;
};

export const safeMentions = { parse: [] };

export const formatJobCard = (job, { projectSlug = '', agents = null, latestEvent = null } = {}) => {
  const status = job.status || 'pending';
  const total = job.total_requirements || 0;
  const verified = job.verified_requirements || 0;
  const proj = projectSlug || job.project_slug || job.project_id || 'unknown';

  // Capitalize status for display
  const titleStatus = status.charAt(0).toUpperCase() + status.slice(1);

  if (status === 'completed') {
    // Only claim PASS if verified by evidence
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

  // During execution (running, auditing, etc.)
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
    latestEvent ? `\nLatest: ${latestEvent}` : '',
    '```'
  ].filter(line => line !== '').join('\n'));
};

export const formatTaskCard = (task, { projectSlug = '', latestEvent = null } = {}) => {
  const status = task.status || 'queued';
  const proj = projectSlug || task.project_slug || task.project_id || 'unknown';
  const titleStatus = status.charAt(0).toUpperCase() + status.slice(1);

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
    return redactSensitive([
      '```',
      'CodeOrchestrator',
      `Task: ${task.id}`,
      `Project: ${proj}`,
      `Status: ${titleStatus}`,
      task.error ? `Error: ${task.error}` : `Exit Code: ${task.exit_code ?? 'N/A'}`,
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
      latestEvent ? `Latest: ${latestEvent}` : '',
      '```'
    ].filter(Boolean).join('\n'));
  }

  // Queued
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

  // Extract failed acceptance criteria safely
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

  const lines = [
    '```',
    'CodeOrchestrator — Audit Result',
    `Subtask ID: ${latest.subtask_id || subtaskId}`,
    `Auditor Verdict: ${verdict}`,
    `Attempts: ${audits.length}`,
    `Failed Criteria: ${failedCriteria.length > 0 ? failedCriteria.map(c => c.name || c.id || c).join(', ') : 'None'}`,
    `Findings: ${findings.length > 0 ? findings.length : 'None'}`,
    `Evidence: ${evidenceSummary}`,
    '```'
  ];

  return redactSensitive(lines.join('\n'));
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

  // If detailed report is too large for single message, return file attachment
  if (fullReportText.length > 1800) {
    return {
      content: redactSensitive(summary),
      attachment: {
        name: `report-${job?.id || 'job'}.txt`,
        data: Buffer.from(fullReportText, 'utf8')
      }
    };
  }

  return {
    content: redactSensitive(`${summary}\n\`\`\`json\n${fullReportText}\n\`\`\``)
  };
};

export default {
  redactSensitive,
  safeMentions,
  formatJobCard,
  formatTaskCard,
  formatAuditReport,
  formatFinalReport
};
