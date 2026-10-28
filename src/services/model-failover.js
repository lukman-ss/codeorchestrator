import { randomUUID } from 'node:crypto';
import { dbGet, dbGetOne, dbRun } from '../database/db.js';
import { ModelRegistry } from './model-registry.js';
import { ModelResolver } from './model-resolver.js';

export class ModelFailover {
  /**
   * Classify failure reason from exit code, stderr, error message, or verification audit.
   */
  static classifyFailure({ exitCode = 0, error = '', stderr = '', auditVerdict = null, findings = [] } = {}) {
    const text = `${error} ${stderr}`.toLowerCase();

    // 1. Security Failure
    if (findings && findings.some(f => f.severity === 'CRITICAL' || f.category === 'secret_exposure' || f.category === 'auth_bypass')) {
      return { category: 'security', recoverable: false, reason: 'Critical security vulnerability detected' };
    }
    if (/\b(synthetic aws key|unauthorized access|forbidden path traversal)\b/i.test(text)) {
      return { category: 'security', recoverable: false, reason: 'Security boundary violated' };
    }

    // 2. Environment / Configuration Failure
    if (/\b(enoent|no such file or directory|repository not found|workspace mismatch|invalid git remote|permission denied)\b/i.test(text)) {
      return { category: 'environment', recoverable: false, reason: 'Environment or filesystem misconfiguration' };
    }

    // 3. Infrastructure / Network Failure
    if (/\b(econnreset|econnrefused|etimedout|socket hang up|gateway timeout|bad gateway|502|503|504|network error)\b/i.test(text)) {
      return { category: 'infrastructure', recoverable: true, reason: 'Upstream gateway or network connectivity failure' };
    }

    // 4. Rate Limit
    if (/\b(429|rate limit|too many requests|quota exceeded|tpm limit|rpm limit)\b/i.test(text)) {
      return { category: 'rate_limit', recoverable: true, reason: 'Upstream provider rate limit' };
    }

    // 5. Model Capability Failure
    if (/\b(tool call failed|function call not supported|context length exceeded|maximum context length|unsupported model|model not found)\b/i.test(text)) {
      return { category: 'capability', recoverable: true, reason: 'Model lacks required tool support or context window capacity' };
    }

    // 6. Reasoning / Implementation Failure (Verification or Code Error)
    if (auditVerdict === 'FAILED' || exitCode !== 0 || /\b(syntaxerror|assertionerror|test failed|failed criteria)\b/i.test(text)) {
      return { category: 'reasoning', recoverable: true, reason: 'Implementation failed syntax, acceptance criteria, or unit tests' };
    }

    return { category: 'reasoning', recoverable: true, reason: 'Unverified execution output' };
  }

  /**
   * Determine recovery plan based on failure category, previous attempts, and policy bounds.
   */
  static planRecovery({
    taskId,
    jobId,
    projectId,
    sessionId,
    currentModel,
    currentEffort = 'medium',
    failureClassification,
    attemptCount = 1,
    switchCount = 0,
    history = [],
    fallbackCandidates = [],
    prompt = '',
    workspacePath = ''
  }) {
    const { category, recoverable, reason } = failureClassification;

    // Hard stop conditions
    if (!recoverable) {
      return {
        strategy: 'blocked',
        reason: `Unrecoverable failure: ${reason}`,
        action: 'HALT'
      };
    }

    if (attemptCount >= 4 || switchCount >= 2) {
      return {
        strategy: 'blocked',
        reason: `Exceeded recovery bounds (attempts: ${attemptCount}/4, switches: ${switchCount}/2)`,
        action: 'HALT'
      };
    }

    const { baseModel } = ModelRegistry.parseModelString(currentModel);

    // Strategy 1: Infrastructure failure -> Bounded retry same model and effort
    if (category === 'infrastructure') {
      ModelRegistry.recordExecutionFailure(baseModel, 'infrastructure', true);
      return {
        strategy: 'retry',
        nextModel: baseModel,
        nextEffort: currentEffort,
        openCodeModel: ModelRegistry.formatOpenCodeModel(baseModel, currentEffort),
        reason: 'Transient infrastructure failure; retrying same model with backoff',
        backoffMs: 1500
      };
    }

    // Strategy 2: Rate limit -> Switch model if available, otherwise backoff
    if (category === 'rate_limit') {
      ModelRegistry.recordExecutionFailure(baseModel, 'rate_limit', true);
      const replacement = this._findAlternativeModel(baseModel, fallbackCandidates);
      if (replacement) {
        return {
          strategy: 'switch_model',
          nextModel: replacement,
          nextEffort: currentEffort,
          openCodeModel: ModelRegistry.formatOpenCodeModel(replacement, currentEffort),
          reason: `Rate limit on '${baseModel}'; switching to alternative model '${replacement}'`
        };
      }
      return {
        strategy: 'retry',
        nextModel: baseModel,
        nextEffort: currentEffort,
        openCodeModel: ModelRegistry.formatOpenCodeModel(baseModel, currentEffort),
        reason: 'Rate limit encountered; retrying after cooling down',
        backoffMs: 3000
      };
    }

    // Strategy 3: Capability failure -> Switch model immediately
    if (category === 'capability') {
      ModelRegistry.recordExecutionFailure(baseModel, 'capability', false);
      const replacement = this._findAlternativeModel(baseModel, fallbackCandidates);
      if (replacement) {
        const validatedVariant = ModelRegistry.validateVariant(replacement, currentEffort);
        return {
          strategy: 'switch_model',
          nextModel: replacement,
          nextEffort: validatedVariant,
          openCodeModel: ModelRegistry.formatOpenCodeModel(replacement, validatedVariant),
          reason: `Model capability deficiency in '${baseModel}'; switched to capable alternative '${replacement}'`
        };
      }
    }

    // Strategy 4: Reasoning failure -> Effort escalation first, then model switch
    if (category === 'reasoning') {
      const registered = ModelRegistry.getModel(baseModel);
      const supportsEffort = registered?.reasoningSupport;

      // If current effort is medium/low and model supports high effort, escalate effort first
      if (supportsEffort && currentEffort !== 'high' && currentEffort !== 'xhigh') {
        const nextEffort = 'high';
        return {
          strategy: 'increase_effort',
          nextModel: baseModel,
          nextEffort,
          openCodeModel: ModelRegistry.formatOpenCodeModel(baseModel, nextEffort),
          reason: `Implementation verification failed; escalating reasoning effort from '${currentEffort}' to '${nextEffort}'`
        };
      }

      // If already at high effort, switch model to alternative
      const replacement = this._findAlternativeModel(baseModel, fallbackCandidates);
      if (replacement) {
        const validatedVariant = ModelRegistry.validateVariant(replacement, 'high') || 'high';
        return {
          strategy: 'switch_model',
          nextModel: replacement,
          nextEffort: validatedVariant,
          openCodeModel: ModelRegistry.formatOpenCodeModel(replacement, validatedVariant),
          reason: `Repeated reasoning failure at high effort on '${baseModel}'; switching model to '${replacement}'`
        };
      }
    }

    // Fallback: bounded retry if within limits
    return {
      strategy: 'retry',
      nextModel: baseModel,
      nextEffort: currentEffort,
      openCodeModel: ModelRegistry.formatOpenCodeModel(baseModel, currentEffort),
      reason: 'Bounded retry with current model'
    };
  }

  /**
   * Find suitable alternative candidate excluding failing model.
   */
  static _findAlternativeModel(failingModel, fallbackCandidates = []) {
    const candidates = fallbackCandidates.filter(c => c !== failingModel && !ModelRegistry.isCircuitBreakerOpen(c));
    if (candidates.length > 0) return candidates[0];

    // Pick from registry
    const all = ModelRegistry.discoverModels();
    const alt = all.find(m => m.id !== failingModel && !ModelRegistry.isCircuitBreakerOpen(m.id) && m.toolSupport);
    return alt ? alt.id : null;
  }

  /**
   * Build durable handoff artifact to preserve all task context across model switches.
   */
  static buildHandoffArtifact({
    taskId,
    projectId,
    previousModel,
    previousEffort,
    nextModel,
    nextEffort,
    failureReason,
    originalPrompt = '',
    filesChanged = [],
    failedCriteria = [],
    workspacePath = ''
  }) {
    const handoff = {
      handoffId: randomUUID(),
      taskId,
      projectId,
      timestamp: new Date().toISOString(),
      previousModel,
      previousEffort,
      nextModel,
      nextEffort,
      failureReason,
      filesChanged,
      failedCriteria,
      workspacePath
    };

    const recoveryPrompt = [
      `[TASK RECOVERY HANDOFF]`,
      `Original Task ID: ${taskId}`,
      `Previous Execution Model: ${previousModel}#${previousEffort || 'standard'} encountered failure: ${failureReason}`,
      filesChanged.length > 0 ? `Files already modified in workspace: ${filesChanged.join(', ')}` : '',
      failedCriteria.length > 0 ? `Issues requiring resolution:\n- ${failedCriteria.join('\n- ')}` : '',
      `Original Requirements:\n${originalPrompt}`,
      `Directive: Continue and repair implementation without discarding existing valid code.`
    ].filter(Boolean).join('\n\n');

    return { handoff, recoveryPrompt };
  }

  /**
   * Persist failover event in SQLite.
   */
  static recordFailoverEvent({
    taskId,
    jobId,
    projectId,
    previousModel,
    previousEffort,
    failureCategory,
    recoveryStrategy,
    nextModel,
    nextEffort,
    handoffArtifact = {}
  }) {
    const id = randomUUID();
    try {
      dbRun(
        `INSERT INTO model_failover_events (
          id, task_id, job_id, project_id, previous_model, previous_effort,
          failure_category, recovery_strategy, next_model, next_effort,
          handoff_artifact_json, context_preserved, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`,
        [
          id, taskId, jobId, projectId, previousModel, previousEffort,
          failureCategory, recoveryStrategy, nextModel, nextEffort,
          JSON.stringify(handoffArtifact)
        ]
      );
    } catch {}
    return id;
  }
}
