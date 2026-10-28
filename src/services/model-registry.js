import { execSync } from 'node:child_process';
import { dbGet, dbGetOne, dbRun } from '../database/db.js';
import { OPENCODE_BIN, DEFAULT_MODEL } from '../config.js';

export class ModelRegistry {
  static _cache = {
    timestamp: 0,
    models: []
  };
  static CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  /**
   * Known static capabilities baseline.
   * ponytail: enrich with dynamic gateway capability endpoint if 9router provides one.
   */
  static MODEL_PROFILES = {
    '9router/ayce-combo': {
      provider: '9router',
      displayName: 'AYCE Combo (Adaptive Ensemble)',
      toolSupport: 1,
      reasoningSupport: 1,
      supportedVariants: ['low', 'medium', 'high'],
      contextLimit: 200000,
      outputLimit: 16384,
      capabilities: ['code_generation', 'repo_exploration', 'debugging', 'multi_step']
    },
    '9router/ag/claude-sonnet-4-6': {
      provider: '9router',
      displayName: 'Claude Sonnet 4.6 (9router)',
      toolSupport: 1,
      reasoningSupport: 1,
      supportedVariants: ['low', 'medium', 'high'],
      contextLimit: 200000,
      outputLimit: 8192,
      capabilities: ['architecture_analysis', 'code_reasoning', 'security_review', 'refactoring']
    },
    '9router/ag/gemini-3.8-flash-high': {
      provider: '9router',
      displayName: 'Gemini 3.8 Flash High (9router)',
      toolSupport: 1,
      reasoningSupport: 1,
      supportedVariants: ['low', 'medium', 'high'],
      contextLimit: 1000000,
      outputLimit: 16384,
      capabilities: ['large_context', 'rapid_generation', 'documentation', 'repo_exploration']
    },
    'opencode/deepseek-v4.1-flash-free': {
      provider: 'opencode',
      displayName: 'DeepSeek v4.1 Flash Free',
      toolSupport: 1,
      reasoningSupport: 1,
      supportedVariants: ['low', 'medium', 'high'],
      contextLimit: 128000,
      outputLimit: 8192,
      capabilities: ['code_generation', 'debugging', 'general_conversation']
    },
    'opencode/glm-5.3-flash-free': {
      provider: 'opencode',
      displayName: 'GLM 5.3 Flash Free',
      toolSupport: 1,
      reasoningSupport: 0,
      supportedVariants: [],
      contextLimit: 128000,
      outputLimit: 4096,
      capabilities: ['code_generation', 'quick_edits']
    },
    'opencode/nemotron-3.5-super-vl-free': {
      provider: 'opencode',
      displayName: 'Nemotron 3.5 Super VL Free',
      toolSupport: 1,
      reasoningSupport: 0,
      supportedVariants: [],
      contextLimit: 128000,
      outputLimit: 4096,
      capabilities: ['general_conversation', 'documentation']
    }
  };

  /**
   * Discover available models from OpenCode CLI / 9router gateway.
   */
  static discoverModels({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (!forceRefresh && (now - this._cache.timestamp < this.CACHE_TTL_MS) && this._cache.models.length > 0) {
      return this._cache.models;
    }

    let discoveredIds = [];
    try {
      const output = execSync(`${OPENCODE_BIN} models`, {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      discoveredIds = output
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('Loaded') && !line.startsWith('Using'));
    } catch {
      // Fallback: use database registry or DEFAULT_MODEL
      const dbEntries = dbGet('SELECT id FROM model_registry WHERE availability_status != ?', ['unavailable']);
      if (dbEntries && dbEntries.length > 0) {
        discoveredIds = dbEntries.map(e => e.id);
      } else {
        discoveredIds = [DEFAULT_MODEL];
      }
    }

    if (discoveredIds.length === 0) {
      discoveredIds = [DEFAULT_MODEL];
    }

    // Persist and synchronize to model_registry table
    for (const rawId of discoveredIds) {
      const { baseModel } = this.parseModelString(rawId);
      const parts = baseModel.split('/');
      const provider = parts.length > 1 ? parts[0] : 'unknown';
      const profile = this.MODEL_PROFILES[baseModel] || {
        provider,
        displayName: baseModel,
        toolSupport: 1,
        reasoningSupport: 0,
        supportedVariants: [],
        contextLimit: 128000,
        outputLimit: 8192,
        capabilities: ['general_code']
      };

      dbRun(
        `INSERT INTO model_registry (
          id, provider, display_name, availability_status, tool_support, reasoning_support,
          supported_variants_json, context_limit, output_limit, capability_metadata_json,
          pricing_metadata_json, health_status, last_checked_at, updated_at
        ) VALUES (?, ?, ?, 'available', ?, ?, ?, ?, ?, ?, '{}', 'healthy', datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          availability_status = 'available',
          last_checked_at = datetime('now'),
          updated_at = datetime('now')`,
        [
          baseModel,
          profile.provider,
          profile.displayName,
          profile.toolSupport,
          profile.reasoningSupport,
          JSON.stringify(profile.supportedVariants),
          profile.contextLimit,
          profile.outputLimit,
          JSON.stringify(profile.capabilities)
        ]
      );
    }

    const currentRows = dbGet('SELECT * FROM model_registry');
    this._cache = {
      timestamp: now,
      models: currentRows.map(r => this._hydrateModelRow(r))
    };

    return this._cache.models;
  }

  static _hydrateModelRow(row) {
    let supportedVariants = [];
    let capabilities = [];
    let pricing = {};
    try { supportedVariants = JSON.parse(row.supported_variants_json || '[]'); } catch {}
    try { capabilities = JSON.parse(row.capability_metadata_json || '[]'); } catch {}
    try { pricing = JSON.parse(row.pricing_metadata_json || '{}'); } catch {}

    return {
      id: row.id,
      provider: row.provider,
      displayName: row.display_name,
      availabilityStatus: row.availability_status,
      toolSupport: Boolean(row.tool_support),
      reasoningSupport: Boolean(row.reasoning_support),
      supportedVariants,
      contextLimit: row.context_limit,
      outputLimit: row.output_limit,
      capabilities,
      pricing,
      healthStatus: row.health_status,
      consecutiveFailures: row.consecutive_failures,
      circuitBreakerUntil: row.circuit_breaker_until,
      lastCheckedAt: row.last_checked_at
    };
  }

  static getModel(modelId) {
    if (!modelId) return null;
    const { baseModel } = this.parseModelString(modelId);
    const row = dbGetOne('SELECT * FROM model_registry WHERE id = ?', [baseModel]);
    if (!row) {
      this.discoverModels();
      const retryRow = dbGetOne('SELECT * FROM model_registry WHERE id = ?', [baseModel]);
      return retryRow ? this._hydrateModelRow(retryRow) : null;
    }
    return this._hydrateModelRow(row);
  }

  static isCircuitBreakerOpen(modelId) {
    const model = this.getModel(modelId);
    if (!model) return false;
    if (model.circuitBreakerUntil) {
      const until = new Date(model.circuitBreakerUntil).getTime();
      if (Date.now() < until) return true;
    }
    return model.healthStatus === 'unhealthy';
  }

  static recordExecutionSuccess(modelId) {
    const { baseModel } = this.parseModelString(modelId);
    dbRun(
      `UPDATE model_registry SET
        consecutive_failures = 0,
        health_status = 'healthy',
        circuit_breaker_until = NULL,
        updated_at = datetime('now')
      WHERE id = ?`,
      [baseModel]
    );
  }

  static recordExecutionFailure(modelId, failureCategory, isProviderError = false) {
    const { baseModel } = this.parseModelString(modelId);
    const model = this.getModel(baseModel);
    if (!model) return;

    if (isProviderError || failureCategory === 'infrastructure' || failureCategory === 'rate_limit') {
      const nextFailures = (model.consecutiveFailures || 0) + 1;
      const shouldTrip = nextFailures >= 3;
      const cooldownSec = failureCategory === 'rate_limit' ? 120 : 60;

      dbRun(
        `UPDATE model_registry SET
          consecutive_failures = ?,
          health_status = ?,
          circuit_breaker_until = ${shouldTrip ? `datetime('now', '+${cooldownSec} seconds')` : 'circuit_breaker_until'},
          updated_at = datetime('now')
        WHERE id = ?`,
        [nextFailures, shouldTrip ? 'unhealthy' : 'degraded', baseModel]
      );
    }
  }

  /**
   * Parse model strings into clean baseModel and variant.
   * e.g., '9router/ayce-combo#high' => { baseModel: '9router/ayce-combo', variant: 'high' }
   */
  static parseModelString(raw) {
    if (!raw || typeof raw !== 'string') {
      return { baseModel: DEFAULT_MODEL, variant: null };
    }
    const clean = raw.trim();
    const hashIndex = clean.indexOf('#');
    if (hashIndex === -1) {
      return { baseModel: clean, variant: null };
    }
    const baseModel = clean.slice(0, hashIndex);
    // ponytail: strip redundant hashes if present, take only first segment
    const variant = clean.slice(hashIndex + 1).split('#')[0].trim() || null;
    return { baseModel, variant };
  }

  /**
   * Cleanly format model string for OpenCode v2.2.0 CLI.
   * Never produces double hashes like 'model#high#high'.
   */
  static formatOpenCodeModel(baseModel, variant = null) {
    const parsed = this.parseModelString(baseModel);
    const effectiveVariant = variant || parsed.variant;
    if (effectiveVariant && effectiveVariant !== 'default') {
      return `${parsed.baseModel}#${effectiveVariant}`;
    }
    return parsed.baseModel;
  }

  /**
   * Validate and normalize reasoning effort against model capabilities.
   */
  static validateVariant(modelId, requestedEffort) {
    if (!requestedEffort) return null;
    const { baseModel } = this.parseModelString(modelId);
    const model = this.getModel(baseModel);
    const effort = requestedEffort.toLowerCase();

    // If model supports explicit variants
    if (model && model.supportedVariants && model.supportedVariants.length > 0) {
      if (model.supportedVariants.includes(effort)) {
        return effort;
      }
      // If xhigh requested but only high supported, downgrade to high
      if (effort === 'xhigh' && model.supportedVariants.includes('high')) {
        return 'high';
      }
      // Fallback to nearest supported
      return model.supportedVariants[0];
    }

    // Default heuristics if model not in registry yet
    if (['low', 'medium', 'high'].includes(effort)) {
      return effort;
    }
    if (effort === 'xhigh') return 'high';
    return null;
  }
}
