import { randomUUID } from 'node:crypto';
import { dbGet, dbGetOne, dbRun } from '../database/db.js';
import { DEFAULT_MODEL, SUPERVISOR_MODEL, WORKER_MODEL, AUDITOR_MODEL, INTEGRATION_MODEL, AUDIT_MODEL_OVERRIDE, INTEGRATION_MODEL_OVERRIDE } from '../config.js';
import { ModelRegistry } from './model-registry.js';
import { TaskIntelligence } from './task-intelligence.js';

export class ModelResolver {
  /**
   * Centralized execution plan resolver.
   * Autonomously determines the optimal AI model and reasoning effort.
   */
  static resolveExecutionPlan({
    taskId = null,
    jobId = null,
    projectId = null,
    sessionId = null,
    role = 'worker',
    prompt = '',
    category = null,
    preferredModel = null,
    preferredEffort = null,
    history = [],
    constraints = {}
  } = {}) {
    // 1. Analyze Task Intelligence
    const analysis = TaskIntelligence.analyzeTask({
      prompt,
      metadata: { category, role },
      history
    });

    // 2. Discover available models from Registry
    const availableModels = ModelRegistry.discoverModels();

    // 3. Check for explicit overrides or role constraints
    let explicitModel = preferredModel;
    if (!explicitModel) {
      if (role === 'auditor' && AUDIT_MODEL_OVERRIDE) explicitModel = AUDIT_MODEL_OVERRIDE;
      else if (role === 'integration' && INTEGRATION_MODEL_OVERRIDE) explicitModel = INTEGRATION_MODEL_OVERRIDE;
    }

    let selectedModel = null;
    let fallbackCandidates = [];
    let selectionSource = 'adaptive_router';
    let selectionReason = '';

    // If explicit preferred model given
    if (explicitModel) {
      const parsed = ModelRegistry.parseModelString(explicitModel);
      const registered = ModelRegistry.getModel(parsed.baseModel);
      if (registered && !ModelRegistry.isCircuitBreakerOpen(parsed.baseModel)) {
        selectedModel = registered;
        selectionSource = 'manual';
        selectionReason = `Explicitly requested model '${explicitModel}' for role '${role}'`;
      } else {
        // Model requested is unavailable or circuit-broken; select fallback
        selectionReason = `Requested model '${explicitModel}' unavailable/circuit-broken; falling back to adaptive selection`;
      }
    }

    // 4. Autonomous Model Selection if not explicitly determined
    if (!selectedModel) {
      const candidates = this._filterAndRankCandidates({
        models: availableModels,
        role,
        analysis,
        history,
        constraints
      });

      if (candidates.length > 0) {
        selectedModel = candidates[0].model;
        selectionReason = selectionReason
          ? `${selectionReason} -> selected candidate '${candidates[0].model.id}': ${candidates[0].reason}`
          : candidates[0].reason;
        fallbackCandidates = candidates.slice(1, 4).map(c => c.model.id);
      } else {
        // Safe fallback
        selectedModel = ModelRegistry.getModel(DEFAULT_MODEL) || {
          id: DEFAULT_MODEL,
          provider: '9router',
          toolSupport: true,
          reasoningSupport: true,
          supportedVariants: ['low', 'medium', 'high']
        };
        selectionReason = selectionReason
          ? `${selectionReason} -> Default model fallback (no suitable candidate passed all filters)`
          : 'Default model fallback (no suitable candidate passed all filters)';
      }
    }

    // 5. Adaptive Reasoning Effort Resolution
    let requestedEffort = preferredEffort;
    if (!requestedEffort && explicitModel) {
      const parsed = ModelRegistry.parseModelString(explicitModel);
      if (parsed.variant) requestedEffort = parsed.variant;
    }
    if (!requestedEffort) {
      requestedEffort = analysis.suggestedEffort;
      // Escalate if previous attempt with same model failed
      const prevFailures = (history || []).filter(h => h.model_id === selectedModel.id && h.verification_outcome === 'failed');
      if (prevFailures.length > 0 && requestedEffort === 'medium') {
        requestedEffort = 'high';
      }
    }

    const validatedVariant = ModelRegistry.validateVariant(selectedModel.id, requestedEffort);
    const openCodeModel = ModelRegistry.formatOpenCodeModel(selectedModel.id, validatedVariant);

    // 6. Persist Routing Decision
    const decisionId = randomUUID();
    try {
      dbRun(
        `INSERT INTO model_routing_decisions (
          id, task_id, job_id, project_id, session_id, role, category, complexity,
          risk, selected_model, requested_effort, validated_variant, opencode_model,
          selection_source, selection_reason, fallback_candidates_json,
          required_capabilities_json, budget_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', datetime('now'))`,
        [
          decisionId,
          taskId,
          jobId,
          projectId,
          sessionId,
          role,
          analysis.category,
          analysis.complexity,
          analysis.risk,
          selectedModel.id,
          requestedEffort,
          validatedVariant,
          openCodeModel,
          selectionSource,
          selectionReason,
          JSON.stringify(fallbackCandidates),
          JSON.stringify(analysis.requiredCapabilities)
        ]
      );
    } catch (err) {
      // Non-fatal if table write fails in unit test environments without full schema
    }

    return {
      decisionId,
      model: selectedModel.id,
      effort: validatedVariant || requestedEffort || 'standard',
      validatedVariant,
      openCodeModel,
      role,
      category: analysis.category,
      complexity: analysis.complexity,
      risk: analysis.risk,
      selectionSource,
      capabilityStatus: 'verified',
      reason: selectionReason,
      fallbackCandidates,
      requiredCapabilities: analysis.requiredCapabilities,
      recoveryPolicy: {
        maxRetries: 2,
        maxModelSwitches: 2,
        effortEscalationAllowed: Boolean(selectedModel.reasoningSupport)
      }
    };
  }

  /**
   * Filter and rank candidate models based on role, capabilities, complexity, and performance history.
   */
  static _filterAndRankCandidates({ models, role, analysis, history, constraints }) {
    const scored = [];

    for (const model of models) {
      // Filter 1: Circuit breaker
      if (ModelRegistry.isCircuitBreakerOpen(model.id)) continue;

      // Filter 2: Availability
      if (model.availabilityStatus === 'unavailable') continue;

      // Filter 3: Tool Support (essential for non-conversational code orchestration)
      if (role !== 'classifier' && analysis.category !== 'general_conversation' && !model.toolSupport) {
        continue;
      }

      // Filter 4: Context Capacity for large context tasks
      if (analysis.contextRequirement === 'large' && model.contextLimit < 200000) {
        continue;
      }

      // Filter 5: Policy Exclusions or Allowlists
      if (constraints.allowedModels && !constraints.allowedModels.includes(model.id)) {
        continue;
      }
      if (constraints.excludedModels && constraints.excludedModels.includes(model.id)) {
        continue;
      }

      // Candidate Scoring
      let score = 50;
      const reasons = [];

      // Role and Category Affinity
      if (role === 'auditor' || analysis.category === 'security_review') {
        if (model.id.includes('claude-sonnet')) {
          score += 40;
          reasons.push('High-precision security and audit capability');
        } else if (model.id.includes('ayce-combo')) {
          score += 25;
          reasons.push('Broad reasoning audit suitability');
        }
      } else if (role === 'supervisor' || analysis.category === 'architecture_analysis') {
        if (model.id.includes('claude-sonnet')) {
          score += 35;
          reasons.push('Superior architectural planning capability');
        } else if (model.id.includes('ayce-combo')) {
          score += 30;
          reasons.push('Proven multi-step planning capability');
        }
      } else if (analysis.category === 'documentation') {
        if (model.id.includes('gemini-3.8-flash-high')) {
          score += 40;
          reasons.push('1M context window and rapid doc generation');
        }
      } else if (analysis.category === 'technical_qa' && analysis.complexity === 'low') {
        if (model.id.includes('flash') || model.id.includes('free')) {
          score += 35;
          reasons.push('Economical and fast response for standard Q&A');
        }
      } else {
        // General Worker / Source Implementation
        if (analysis.complexity === 'high') {
          if (model.id.includes('ayce-combo')) {
            score += 35;
            reasons.push('Full-stack multi-file implementation ensemble');
          } else if (model.id.includes('claude-sonnet')) {
            score += 30;
            reasons.push('Complex code reasoning capability');
          }
        } else {
          // Medium / routine implementation
          if (model.id.includes('ayce-combo')) {
            score += 25;
            reasons.push('Standard coding orchestrator worker');
          } else if (model.id.includes('deepseek') || model.id.includes('gemini')) {
            score += 20;
            reasons.push('Capable routine code worker');
          }
        }
      }

      // Reasoning variant support boost for complex tasks
      if (analysis.complexity === 'high' && model.reasoningSupport) {
        score += 15;
        reasons.push('Supports deep reasoning effort variants');
      }

      // Check historical performance
      try {
        const perf = dbGetOne('SELECT * FROM model_performance_history WHERE model_id = ? AND category = ?', [model.id, analysis.category]);
        if (perf && perf.total_executions >= 3) {
          const successRate = perf.verified_successes / perf.total_executions;
          if (successRate >= 0.8) {
            score += 20;
            reasons.push(`High verified historical success rate (${Math.round(successRate * 100)}%)`);
          } else if (successRate < 0.4) {
            score -= 25;
            reasons.push(`Low verified historical success rate (${Math.round(successRate * 100)}%)`);
          }
        }
      } catch {}

      scored.push({
        model,
        score,
        reason: reasons.length > 0 ? reasons.join('; ') : 'General capability match'
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
}
