import { randomUUID } from 'node:crypto';
import { dbGet, dbGetOne, dbRun } from '../database/db.js';
import { DEFAULT_MODEL } from '../config.js';
import { ModelResolver } from './model-resolver.js';
import { ModelRegistry } from './model-registry.js';

export class ModelRouter {
  /**
   * Deterministic model routing, token accounting, and budget enforcement.
   */

  static resolveExecutionPlan(params) {
    return ModelResolver.resolveExecutionPlan(params);
  }

  static initDefaultPolicies() {
    const existing = dbGetOne('SELECT COUNT(*) as cnt FROM model_policies');
    if (existing && existing.cnt > 0) return;

    const categories = [
      'intent_classification',
      'general_conversation',
      'architecture_analysis',
      'source_implementation',
      'debugging',
      'testing',
      'requirement_verification',
      'security_review',
      'documentation',
      'summarization'
    ];

    for (const cat of categories) {
      dbRun(
        `INSERT OR IGNORE INTO model_policies (id, category, primary_model, fallback_models_json, max_tokens, temperature, description)
         VALUES (?, ?, ?, '[]', 4096, 0.2, ?)`,
        [randomUUID(), cat, DEFAULT_MODEL, `Default policy for ${cat}`]
      );
    }
  }

  static resolveModel(category, preferredModel = null) {
    if (preferredModel) {
      return { model: preferredModel, maxTokens: 4096, temperature: 0.2, category };
    }

    const policy = dbGetOne('SELECT * FROM model_policies WHERE category = ?', [category]);
    if (policy) {
      let fallbacks = [];
      try { fallbacks = JSON.parse(policy.fallback_models_json || '[]'); } catch {}
      return {
        model: policy.primary_model || DEFAULT_MODEL,
        fallbacks,
        maxTokens: policy.max_tokens || 4096,
        temperature: policy.temperature ?? 0.2,
        category
      };
    }

    return { model: DEFAULT_MODEL, fallbacks: [], maxTokens: 4096, temperature: 0.2, category };
  }

  static checkBudget({ scope = 'project', scopeId = null, estimatedTokens = 0 } = {}) {
    // Check global budget first
    const globalBudget = dbGetOne("SELECT * FROM budget_allocations WHERE scope = 'global'");
    if (globalBudget) {
      if (globalBudget.status === 'paused') {
        return { allowed: false, reason: 'Global token budget is paused by administrator.' };
      }
      if (globalBudget.status === 'exhausted' || (globalBudget.consumed_tokens + estimatedTokens > globalBudget.max_tokens)) {
        return { allowed: false, reason: 'Global token budget exhausted.' };
      }
    }

    // Check specific scope budget
    if (scope && scopeId) {
      const scopeBudget = dbGetOne('SELECT * FROM budget_allocations WHERE scope = ? AND scope_id = ?', [scope, scopeId]);
      if (scopeBudget) {
        if (scopeBudget.status === 'paused') {
          return { allowed: false, reason: `Token budget for ${scope} '${scopeId}' is paused.` };
        }
        if (scopeBudget.status === 'exhausted' || (scopeBudget.consumed_tokens + estimatedTokens > scopeBudget.max_tokens)) {
          return { allowed: false, reason: `Token budget exhausted for ${scope} '${scopeId}'.` };
        }
      }
    }

    return { allowed: true };
  }

  static recordUsage({
    taskId = null,
    jobId = null,
    projectId = null,
    sessionId = null,
    userId = null,
    model = DEFAULT_MODEL,
    category = 'general_conversation',
    inputTokens = 0,
    outputTokens = 0,
    cacheTokens = 0,
    durationMs = 0,
    retries = 0,
    providerError = null,
    isEstimated = 0,
    estimatedCostUsd = 0.0
  }) {
    const id = randomUUID();
    const totalTokens = (inputTokens || 0) + (outputTokens || 0);

    dbRun(
      `INSERT INTO model_usage (
        id, task_id, job_id, project_id, session_id, user_id,
        model, category, input_tokens, output_tokens, cache_tokens, total_tokens,
        duration_ms, retries, provider_error, is_estimated, estimated_cost_usd, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        id,
        taskId,
        jobId,
        projectId,
        sessionId,
        userId,
        model,
        category,
        inputTokens,
        outputTokens,
        cacheTokens,
        totalTokens,
        durationMs,
        retries,
        providerError,
        isEstimated ? 1 : 0,
        estimatedCostUsd
      ]
    );

    // Consume from budgets
    if (totalTokens > 0) {
      this._consumeTokens('global', null, totalTokens, estimatedCostUsd);
      if (projectId) this._consumeTokens('project', projectId, totalTokens, estimatedCostUsd);
      if (userId) this._consumeTokens('user', userId, totalTokens, estimatedCostUsd);
      if (taskId) this._consumeTokens('task', taskId, totalTokens, estimatedCostUsd);
    }

    return this.getUsage(id);
  }

  static _consumeTokens(scope, scopeId, tokens, cost) {
    const sql = scopeId
      ? 'SELECT * FROM budget_allocations WHERE scope = ? AND scope_id = ?'
      : "SELECT * FROM budget_allocations WHERE scope = 'global'";
    const params = scopeId ? [scope, scopeId] : [];
    const b = dbGetOne(sql, params);
    if (!b) return;

    const newConsumed = (b.consumed_tokens || 0) + tokens;
    const newCost = (b.consumed_cost_usd || 0.0) + (cost || 0.0);
    const newStatus = newConsumed >= b.max_tokens ? 'exhausted' : b.status;

    dbRun(
      `UPDATE budget_allocations SET consumed_tokens = ?, consumed_cost_usd = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
      [newConsumed, newCost, newStatus, b.id]
    );
  }

  static getUsage(id) {
    return dbGetOne('SELECT * FROM model_usage WHERE id = ?', [id]);
  }

  static getAggregateUsage({ projectId = null, sessionId = null } = {}) {
    let sql = `
      SELECT
        COUNT(*) as calls_count,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(estimated_cost_usd) as total_cost_usd
      FROM model_usage WHERE 1=1
    `;
    const params = [];
    if (projectId) {
      sql += ' AND project_id = ?';
      params.push(projectId);
    }
    if (sessionId) {
      sql += ' AND session_id = ?';
      params.push(sessionId);
    }
    const res = dbGetOne(sql, params);
    return {
      callsCount: res?.calls_count || 0,
      totalInputTokens: res?.total_input_tokens || 0,
      totalOutputTokens: res?.total_output_tokens || 0,
      totalTokens: res?.total_tokens || 0,
      totalCostUsd: res?.total_cost_usd || 0.0
    };
  }

  static setBudget({ scope, scopeId = null, maxTokens = 1000000, maxCostUsd = 100.0, status = 'active' }) {
    const id = randomUUID();
    dbRun(
      `INSERT INTO budget_allocations (id, scope, scope_id, max_tokens, max_cost_usd, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(scope, scope_id) DO UPDATE SET
         max_tokens = excluded.max_tokens,
         max_cost_usd = excluded.max_cost_usd,
         status = excluded.status,
         updated_at = datetime('now')`,
      [id, scope, scopeId, maxTokens, maxCostUsd, status]
    );
    return dbGetOne('SELECT * FROM budget_allocations WHERE scope = ? AND (scope_id = ? OR (scope_id IS NULL AND ? IS NULL))', [scope, scopeId, scopeId]);
  }

  static recordExecutionAttempt({
    decisionId = null,
    taskId = null,
    jobId = null,
    projectId = null,
    sessionId = null,
    agentRole = 'worker',
    attemptNumber = 1,
    modelId = DEFAULT_MODEL,
    requestedEffort = null,
    selectedVariant = null,
    openCodeModel = DEFAULT_MODEL,
    capabilityStatus = 'verified',
    selectionReason = null,
    failureCategory = 'none',
    verificationOutcome = 'pending',
    inputTokens = 0,
    outputTokens = 0,
    durationMs = 0,
    errorMessage = null
  } = {}) {
    const id = randomUUID();
    try {
      dbRun(
        `INSERT INTO model_execution_attempts (
          id, decision_id, task_id, job_id, project_id, session_id, agent_role, attempt_number,
          model_id, requested_effort, selected_variant, opencode_model, capability_status,
          selection_reason, failure_category, verification_outcome, input_tokens, output_tokens,
          duration_ms, error_message, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ${verificationOutcome !== 'pending' ? "datetime('now')" : 'NULL'})`,
        [
          id, decisionId, taskId, jobId, projectId, sessionId, agentRole, attemptNumber,
          modelId, requestedEffort, selectedVariant, openCodeModel, capabilityStatus,
          selectionReason, failureCategory, verificationOutcome, inputTokens, outputTokens,
          durationMs, errorMessage
        ]
      );
    } catch {}
    return id;
  }

  static recordOutcome({
    modelId = DEFAULT_MODEL,
    category = 'source_implementation',
    verified = true,
    tokens = 0,
    durationMs = 0,
    repairAttempts = 0
  } = {}) {
    const { baseModel } = ModelRegistry.parseModelString(modelId);
    try {
      dbRun(
        `INSERT INTO model_performance_history (
          id, model_id, category, total_executions, verified_successes, failures,
          total_repair_attempts, total_tokens, avg_duration_ms, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(model_id, category) DO UPDATE SET
          total_executions = total_executions + 1,
          verified_successes = verified_successes + excluded.verified_successes,
          failures = failures + excluded.failures,
          total_repair_attempts = total_repair_attempts + excluded.total_repair_attempts,
          total_tokens = total_tokens + excluded.total_tokens,
          avg_duration_ms = (avg_duration_ms * total_executions + excluded.avg_duration_ms) / (total_executions + 1),
          updated_at = datetime('now')`,
        [
          randomUUID(), baseModel, category,
          verified ? 1 : 0,
          verified ? 0 : 1,
          repairAttempts,
          tokens,
          durationMs
        ]
      );
    } catch {}
  }
}
