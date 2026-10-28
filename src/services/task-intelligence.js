/**
 * Task Intelligence Engine
 * Deterministic intent classification, multi-factor complexity scoring,
 * risk analysis, and required model capability extraction.
 */
export class TaskIntelligence {
  /**
   * Complete task intelligence analysis.
   */
  static analyzeTask({ prompt = '', metadata = {}, history = [] } = {}) {
    const text = String(prompt || '').trim();
    const category = this.classifyIntent(text, metadata);
    const complexity = this.analyzeComplexity(text, metadata, history);
    const risk = this.analyzeRisk(text, metadata);
    const capabilityRequirements = this.extractCapabilityRequirements(category, complexity, risk, text);

    return {
      category,
      complexity: complexity.level,
      complexityScore: complexity.score,
      complexityFactors: complexity.factors,
      risk: risk.level,
      riskScore: risk.score,
      riskFactors: risk.factors,
      requiredCapabilities: capabilityRequirements.capabilities,
      contextRequirement: capabilityRequirements.contextRequirement,
      suggestedEffort: capabilityRequirements.suggestedEffort,
      reason: complexity.summary || `Task classified as ${category} (${complexity.level} complexity, ${risk.level} risk)`
    };
  }

  /**
   * Deterministic intent classification.
   */
  static classifyIntent(prompt, metadata = {}) {
    if (metadata.category) return metadata.category;
    const lower = prompt.toLowerCase();

    // Check specific intent patterns
    if (/\b(audit|security|vulnerability|cve|penetration|secret|bypass|sql injection|xss|owasp|token handling)\b/i.test(lower)) {
      return 'security_review';
    }
    if (/\b(debug|fix|bug|deadlock|race condition|traceback|exception|crash|panic|segfault|reproduce bug)\b/i.test(lower)) {
      return 'debugging';
    }
    if (/\b(test|unit test|integration test|e2e test|coverage|mocking|assert)\b/i.test(lower) && !/\b(build|create|implement)\b/i.test(lower)) {
      return 'testing';
    }
    if (/\b(migrate|migration|alter table|create table|drop table|foreign key|schema update)\b/i.test(lower)) {
      return 'database_migration';
    }
    if (/\b(architecture|design system|system design|adr|rfc|tech spec|diagram)\b/i.test(lower)) {
      return 'architecture_analysis';
    }
    if (/\b(readme|documentation|docstring|api docs|markdown guide|manual)\b/i.test(lower) && !/\b(implement|code|build)\b/i.test(lower)) {
      return 'documentation';
    }
    if (/\b(review|git review|pull request|diff review|pr review)\b/i.test(lower)) {
      return 'git_review';
    }
    if (/\b(summarize|recap|summary|briefing)\b/i.test(lower)) {
      return 'summarization';
    }
    if (/\b(explain|what is|how does|why does|difference between|compare)\b/i.test(lower) && prompt.length < 500 && !/\b(build|write code|implement)\b/i.test(lower)) {
      return 'technical_qa';
    }
    if (/\b(build|implement|create|develop|refactor|add feature|rewrite)\b/i.test(lower) || prompt.includes('```') || lower.includes('todo')) {
      return 'source_implementation';
    }

    // Default conversational or Q&A if brief and no code directives
    if (prompt.length < 150 && !prompt.includes('\n')) {
      return 'general_conversation';
    }

    return 'source_implementation';
  }

  /**
   * Multi-dimensional complexity analysis.
   * Not solely based on prompt length!
   */
  static analyzeComplexity(prompt, metadata = {}, history = []) {
    let score = 0;
    const factors = [];
    const lower = prompt.toLowerCase();

    // 1. Mandatory requirements count (numbered items, bullet points, checkbox items)
    const bulletMatches = prompt.match(/^[\s]*[-*+]\s+[^\n]+/gm) || [];
    const numberedMatches = prompt.match(/^[\s]*\d+\.\s+[^\n]+/gm) || [];
    const reqCount = bulletMatches.length + numberedMatches.length;
    if (reqCount >= 8) {
      score += 35;
      factors.push(`High requirement count (${reqCount} items)`);
    } else if (reqCount >= 4) {
      score += 20;
      factors.push(`Multiple requirements (${reqCount} items)`);
    } else if (reqCount > 0) {
      score += 10;
    }

    // 2. Technical depth & architectural patterns
    const deepTechPatterns = [
      /\b(concurrency|deadlock|mutex|race condition|channel|goroutine|worker pool)\b/i,
      /\b(distributed|consensus|raft|grpc|microservice|event-driven|websocket)\b/i,
      /\b(transaction|acid|isolation level|optimistic lock|idempotency)\b/i,
      /\b(ast|compiler|lexer|parser|memory leak|profiling|gc)\b/i,
      /\b(cryptography|hmac|jwt|oauth2|pki|tls|mtls)\b/i
    ];
    let matchedDeep = 0;
    for (const pattern of deepTechPatterns) {
      if (pattern.test(lower)) matchedDeep++;
    }
    if (matchedDeep >= 2) {
      score += 30;
      factors.push(`Deep architectural/concurrency requirements`);
    } else if (matchedDeep === 1) {
      score += 15;
      factors.push(`Advanced technical pattern detected`);
    }

    // 3. Multi-module / full-stack scope
    const isFullStack = /\b(full-stack|fullstack|frontend\s+and\s+backend|client\s+and\s+server)\b/i.test(lower) ||
      (/\b(react|vue|ui|html|css)\b/i.test(lower) && /\b(postgres|database|api|endpoint|backend)\b/i.test(lower));
    if (isFullStack) {
      score += 25;
      factors.push('Cross-module / full-stack scope');
    }

    // 4. Testing requirements
    if (/\b(unit tests?|integration tests?|e2e|test suite)\b/i.test(lower)) {
      score += 15;
      factors.push('Automated testing suite required');
    }

    // 5. Historical execution failures
    const failedAttempts = (history || []).filter(h => h.verification_outcome === 'failed' || h.failure_category);
    if (failedAttempts.length >= 2) {
      score += 30;
      factors.push(`Repeated previous execution failures (${failedAttempts.length})`);
    } else if (failedAttempts.length === 1) {
      score += 15;
      factors.push('Previous implementation attempt failed');
    }

    // 6. Token / length factor (minimal weight, bounded)
    if (prompt.length > 3000) {
      score += 15;
      factors.push('Extensive prompt specification');
    } else if (prompt.length > 1000) {
      score += 5;
    }

    // Determine level
    let level = 'low';
    if (score >= 60) level = 'high';
    else if (score >= 30) level = 'medium';

    return {
      score,
      level,
      factors,
      summary: factors.length > 0 ? factors.join('; ') : 'Standard routine task'
    };
  }

  /**
   * Risk analysis: security, data loss, destructive operations.
   */
  static analyzeRisk(prompt, metadata = {}) {
    let score = 0;
    const factors = [];
    const lower = prompt.toLowerCase();

    // 1. Authentication & Security sensitivity
    if (/\b(auth|authentication|jwt|token|secret|password|credential|rsa|private_key|api_key|session hijack|csrf|bypass)\b/i.test(lower)) {
      score += 40;
      factors.push('Authentication / credential sensitive');
    }

    // 2. Database migrations & data persistence
    if (/\b(drop table|drop database|truncate|migrate|alter table|delete from|schema change)\b/i.test(lower)) {
      score += 35;
      factors.push('Database schema alteration or data loss potential');
    }

    // 3. Destructive or system-level actions
    if (/\b(rm -rf|unlink|delete all|reset --hard|force push|sudo|chmod 777)\b/i.test(lower)) {
      score += 45;
      factors.push('Destructive filesystem or git operation');
    }

    // 4. External production infrastructure
    if (/\b(production|deploy|k8s|kubernetes|terraform|cloudformation|aws|gcp)\b/i.test(lower)) {
      score += 25;
      factors.push('Production deployment / infrastructure affected');
    }

    let level = 'low';
    if (score >= 50) level = 'high';
    else if (score >= 25) level = 'medium';

    return { score, level, factors };
  }

  /**
   * Map category, complexity, and risk into model capability requirements.
   */
  static extractCapabilityRequirements(category, complexity, risk, prompt) {
    const capabilities = new Set(['tool_calling']);
    let contextRequirement = 'standard';
    let suggestedEffort = 'medium';

    // Tool calling & exploration
    if (['source_implementation', 'debugging', 'testing', 'architecture_analysis'].includes(category)) {
      capabilities.add('repo_exploration');
      capabilities.add('multi_step');
    }

    // Coding & reasoning
    if (['source_implementation', 'debugging', 'testing'].includes(category)) {
      capabilities.add('code_generation');
    }
    if (['architecture_analysis', 'debugging', 'security_review'].includes(category) || complexity.level === 'high') {
      capabilities.add('code_reasoning');
    }
    if (category === 'security_review' || risk.level === 'high') {
      capabilities.add('security_review');
    }

    // Context size
    if (prompt.length > 50000 || complexity.score > 70 || category === 'architecture_analysis') {
      contextRequirement = 'large';
      capabilities.add('large_context');
    }

    // Reasoning effort mapping
    if (category === 'general_conversation' || (category === 'technical_qa' && complexity.level === 'low')) {
      suggestedEffort = 'low';
    } else if (complexity.level === 'high' || risk.level === 'high' || category === 'security_review') {
      suggestedEffort = 'high';
    } else {
      suggestedEffort = 'medium';
    }

    return {
      capabilities: Array.from(capabilities),
      contextRequirement,
      suggestedEffort
    };
  }
}
