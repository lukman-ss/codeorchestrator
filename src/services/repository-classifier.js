import { normalizeGitUrl } from './project-service.js';

export const REPOSITORY_ROLES = Object.freeze({
  TARGET: 'TARGET',
  STARTER: 'STARTER',
  TEMPLATE: 'TEMPLATE',
  FRAMEWORK_DEPENDENCY: 'FRAMEWORK_DEPENDENCY',
  LIBRARY_DEPENDENCY: 'LIBRARY_DEPENDENCY',
  DOCUMENTATION: 'DOCUMENTATION',
  EXAMPLE: 'EXAMPLE',
  SUBMODULE: 'SUBMODULE',
  EXTERNAL_REFERENCE: 'EXTERNAL_REFERENCE',
  UNKNOWN: 'UNKNOWN'
});

/**
 * Extracts candidate Git repository URLs from free-form text.
 */
export function extractCandidateUrls(text = '') {
  if (!text || typeof text !== 'string') return [];
  const candidates = [];
  const regex = /(?:https?:\/\/[^\s\)\],>"'`]+|git@[^\s\)\],>"'`]+|ssh:\/\/[^\s\)\],>"'`]+)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const rawUrl = match[0].replace(/[.,;:!?)>"'`]+$/, '').trim();
    candidates.push({ rawUrl, index: match.index });
  }
  return candidates;
}

/**
 * Classifies repository references found in message text, attachments, or markdown documentation.
 *
 * ponytail: deterministic heuristics cover 99% of cases; upgrade path: bounded LLM intent classification for genuine ambiguity
 */
export function classifyRepositoryReferences(text = '', options = {}) {
  if (!text || typeof text !== 'string') return [];

  const candidates = extractCandidateUrls(text);
  if (candidates.length === 0) return [];

  const lines = text.split(/\r?\n/);

  // Helper to find line number and surrounding context by character offset
  function getContext(charIndex) {
    let currentOffset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineStart = currentOffset;
      const lineEnd = currentOffset + line.length;
      if (charIndex >= lineStart && charIndex <= lineEnd) {
        const prevLine = i > 0 ? lines[i - 1] : '';
        const prevPrevLine = i > 1 ? lines[i - 2] : '';
        const nextLine = i < lines.length - 1 ? lines[i + 1] : '';
        return {
          lineIndex: i,
          line,
          prevLine,
          prevPrevLine,
          nextLine,
          offsetInLine: charIndex - lineStart
        };
      }
      currentOffset += line.length + 1; // +1 for newline
    }
    return { lineIndex: 0, line: text, prevLine: '', prevPrevLine: '', nextLine: '', offsetInLine: 0 };
  }

  // Helper to check if offset is inside a markdown code fence
  function isInsideCodeBlock(charIndex) {
    const textBefore = text.slice(0, charIndex);
    const tripleTicks = (textBefore.match(/```/g) || []).length;
    return tripleTicks % 2 !== 0;
  }

  const results = [];
  const seenUrls = new Set();

  for (const { rawUrl, index } of candidates) {
    const norm = normalizeGitUrl(rawUrl, options);
    if (!norm.valid) continue;

    const canonical = norm.canonical;
    const cleanUrl = rawUrl;

    if (seenUrls.has(canonical)) continue;
    seenUrls.add(canonical);

    const ctx = getContext(index);
    const line = ctx.line.trim();
    const lineLower = line.toLowerCase();
    const prefixOnLine = ctx.line.slice(0, ctx.offsetInLine).toLowerCase();
    const prevContext = `${ctx.prevPrevLine}\n${ctx.prevLine}`.toLowerCase();
    const inCodeBlock = isInsideCodeBlock(index);
    const inQuote = line.startsWith('>');

    let role = REPOSITORY_ROLES.UNKNOWN;
    let target = false;
    let confidence = 0.8;
    let source = 'heuristic';

    // 1. Check for explicit TARGET / SCOPE CONFLICT action phrases targeting this repository directly
    const cleanPrefix = prefixOnLine.replace(/<@!?[a-zA-Z0-9_-]+>/g, '').trim();

    const isConfigureRemote = /\b(?:configure\s+(?:git\s+)?remote|set\s+(?:git\s+)?remote)\b/i.test(cleanPrefix) ||
      /\b(?:configure\s+(?:git\s+)?remote|set\s+(?:git\s+)?remote)\b/i.test(lineLower);

    const hasModifyAction = /\b(modify|change|edit|update|ubah|perbarui)\b.*\b(repository|repo|source|repositori)\b.*\b(directly|langsung)\b/i.test(line) ||
      /\b(modify|ubah)\b.*\b(the\s+)?(source\s+)?(repository|repo|repositori)\s+(?:https?:\/\/|git@)/i.test(line) ||
      /\b(push|commit|kirim)\b.*\b(to|ke)\b.*\b(repository|repo)\b/i.test(line);

    const isExplicitTargetDirective = /^(?:target\s*(?:repository|repo)?|destination\s*(?:repository|repo)?)\s*[:=]?/i.test(cleanPrefix);

    // Unqualified repo/remote directive (e.g. "repo: https://...", "remote: https://...", or "git remote git@...")
    const isUnqualifiedRepoDirective = /^(?:(?:git\s+)?remote|repo|repository)\s*[:=]?/i.test(cleanPrefix) &&
      !/(?:starter|template|framework|doc|documentation|library|dependency|example|contoh)/i.test(cleanPrefix);

    if (hasModifyAction || isConfigureRemote || isExplicitTargetDirective || isUnqualifiedRepoDirective) {
      role = REPOSITORY_ROLES.TARGET;
      target = true;
      confidence = 1.0;
      source = isConfigureRemote ? 'configure_remote_directive' : 'action_directive';
    } else if (inCodeBlock) {
      role = REPOSITORY_ROLES.EXTERNAL_REFERENCE;
      target = false;
      confidence = 0.9;
      source = 'code_block';
    } else if (inQuote) {
      role = REPOSITORY_ROLES.EXTERNAL_REFERENCE;
      target = false;
      confidence = 0.9;
      source = 'blockquote';
    } else if (
      /\b(?:starter|fondasi)\b/i.test(prefixOnLine) ||
      /\b(?:starter|fondasi)\b/i.test(lineLower)
    ) {
      role = REPOSITORY_ROLES.STARTER;
      target = false;
      confidence = 1.0;
      source = 'starter_context';
    } else if (
      /\b(?:template|basis)\b/i.test(prefixOnLine) ||
      /\b(?:template|basis)\b/i.test(lineLower)
    ) {
      role = REPOSITORY_ROLES.TEMPLATE;
      target = false;
      confidence = 1.0;
      source = 'template_context';
    } else if (
      /\b(?:framework|kerangka)\b/i.test(prefixOnLine) ||
      /\b(?:framework|kerangka)\b/i.test(lineLower)
    ) {
      role = REPOSITORY_ROLES.FRAMEWORK_DEPENDENCY;
      target = false;
      confidence = 1.0;
      source = 'framework_context';
    } else if (
      /\b(?:library|lib|dependency|dependencies|dep|deps|package|modul)\b/i.test(prefixOnLine) ||
      /\b(?:library|lib|dependency|dependencies|dep|deps)\b/i.test(lineLower) ||
      /\bgo\s+(?:get|module)\b/i.test(lineLower)
    ) {
      role = REPOSITORY_ROLES.LIBRARY_DEPENDENCY;
      target = false;
      confidence = 0.95;
      source = 'dependency_context';
    } else if (
      /\b(?:documentation|docs?|dokumentasi|reference|ref|referensi|manual|guide)\b/i.test(prefixOnLine) ||
      /\b(?:documentation|docs?|dokumentasi|reference|ref|referensi)\b/i.test(lineLower) ||
      /\b(?:read documentation|baca dokumentasi)\b/i.test(lineLower)
    ) {
      role = REPOSITORY_ROLES.DOCUMENTATION;
      target = false;
      confidence = 0.95;
      source = 'doc_context';
    } else if (
      /\b(?:example|contoh|sample|demo|tutorial)\b/i.test(prefixOnLine) ||
      /\b(?:example|contoh|sample|demo)\b/i.test(lineLower)
    ) {
      role = REPOSITORY_ROLES.EXAMPLE;
      target = false;
      confidence = 0.95;
      source = 'example_context';
    } else if (/\bsubmodule\b/i.test(lineLower) || /\bgit submodule\b/i.test(lineLower)) {
      role = REPOSITORY_ROLES.SUBMODULE;
      target = false;
      confidence = 0.95;
      source = 'submodule_context';
    } else if (/\b(?:starter|fondasi)\b/i.test(prevContext)) {
      role = REPOSITORY_ROLES.STARTER;
      target = false;
      confidence = 0.85;
      source = 'starter_context';
    } else if (/\b(?:template|basis)\b/i.test(prevContext)) {
      role = REPOSITORY_ROLES.TEMPLATE;
      target = false;
      confidence = 0.85;
      source = 'template_context';
    } else if (/\b(?:framework|kerangka)\b/i.test(prevContext)) {
      role = REPOSITORY_ROLES.FRAMEWORK_DEPENDENCY;
      target = false;
      confidence = 0.85;
      source = 'framework_context';
    } else if (/\b(?:library|lib|dependency|dependencies|dep|deps)\b/i.test(prevContext)) {
      role = REPOSITORY_ROLES.LIBRARY_DEPENDENCY;
      target = false;
      confidence = 0.85;
      source = 'dependency_context';
    } else if (/\b(?:documentation|docs?|reference|referensi)\b/i.test(prevContext)) {
      role = REPOSITORY_ROLES.DOCUMENTATION;
      target = false;
      confidence = 0.85;
      source = 'doc_context';
    } else if (/\b(?:example|sample|contoh)\b/i.test(prevContext)) {
      role = REPOSITORY_ROLES.EXAMPLE;
      target = false;
      confidence = 0.85;
      source = 'example_context';
    } else {
      // Check if URL matches default target project repository if supplied
      if (options.defaultTargetCanonical && options.defaultTargetCanonical.toLowerCase() === canonical.toLowerCase()) {
        role = REPOSITORY_ROLES.TARGET;
        target = true;
        confidence = 0.9;
        source = 'matches_project_canonical';
      } else {
        // Safe fail-closed without false positives: unknown or body reference is NOT target
        role = REPOSITORY_ROLES.EXTERNAL_REFERENCE;
        target = false;
        confidence = 0.7;
        source = 'unclassified_body_reference';
      }
    }

    results.push({
      url: cleanUrl,
      canonical,
      role,
      target,
      confidence,
      source
    });
  }

  return results;
}
