import { randomUUID } from 'node:crypto';
import { dbGet, dbGetOne, dbRun } from '../database/db.js';
import { getProject, normalizeGitUrl, areEquivalentGitUrls } from './project-service.js';
import { GitOperations } from './git-operations.js';
import { classifyRepositoryReferences, REPOSITORY_ROLES } from './repository-classifier.js';
import logger from '../logger.js';

export class ProjectContextResolver {
  /**
   * Resolves canonical project context and enforces repository authority precedence.
   *
   * Precedence Hierarchy:
   * 1. Server-side authorization and workspace security policy.
   * 2. Explicit project selection in the current authenticated request (project: <slug>).
   * 3. Registered project metadata and verified Git identity.
   * 4. Existing authorized session association when no explicit project switch is requested.
   * 5. Repository-role interpretation of the specification.
   * 6. Previous conversation context.
   */
  static resolveProjectContext({
    projectDirective = null,
    project = null,
    projectId = null,
    projectSlug = null,
    session = null,
    sessionId = null,
    promptText = '',
    attachments = [],
    overrides = {},
    allowLocal = false
  } = {}) {
    let resolvedProject = project;

    // Precedence Tier 2: Explicit project directive in current request
    const explicitSlug = projectDirective || projectSlug;
    if (!resolvedProject && explicitSlug) {
      resolvedProject = dbGetOne(
        'SELECT * FROM projects WHERE slug = ? OR name = ?',
        [explicitSlug.trim(), explicitSlug.trim()]
      );
    }

    // Precedence Tier 3: Explicit project ID
    if (!resolvedProject && projectId) {
      try {
        resolvedProject = getProject(projectId);
      } catch {}
    }

    // Precedence Tier 4: Session association (when no explicit project was given)
    let resolvedSession = session;
    if (!resolvedSession && sessionId) {
      resolvedSession = dbGetOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    }
    if (!resolvedProject && resolvedSession?.project_id) {
      try {
        resolvedProject = getProject(resolvedSession.project_id);
      } catch {}
    }

    // Combine prompt and attachments content for repository reference extraction
    let fullContent = promptText || '';
    if (Array.isArray(attachments) && attachments.length > 0) {
      const attachContent = attachments
        .map(a => (typeof a === 'string' ? a : (a.content || '')))
        .filter(Boolean)
        .join('\n\n');
      if (attachContent) {
        fullContent = fullContent ? `${fullContent}\n\n${attachContent}` : attachContent;
      }
    }

    const defaultCanonical = resolvedProject
      ? normalizeGitUrl(resolvedProject.repository_url || resolvedProject.repo_url || '', { allowLocal }).canonical
      : null;

    // Precedence Tier 5: Repository role classification
    const references = classifyRepositoryReferences(fullContent, {
      defaultTargetCanonical: defaultCanonical,
      allowLocal
    });

    // If no project resolved yet, check if there is an explicit TARGET reference that matches an existing project
    if (!resolvedProject) {
      const targetRef = references.find(r => r.target);
      if (targetRef) {
        const found = dbGetOne(
          'SELECT * FROM projects WHERE repo_url = ? OR repository_url = ?',
          [targetRef.url, targetRef.url]
        );
        if (found) resolvedProject = found;
      }
    }

    // If project is still not resolved
    if (!resolvedProject) {
      return {
        project: null,
        repository_references: references,
        execution: {
          project: null,
          allowed: false,
          validation_result: 'NO_PROJECT_RESOLVED',
          validation_reason: 'No target project resolved from request, session, or registered metadata.',
          scope_conflict: false
        }
      };
    }

    const projectNorm = normalizeGitUrl(resolvedProject.repository_url || resolvedProject.repo_url || '', { allowLocal });
    const projectCanonical = projectNorm.valid ? projectNorm.canonical : null;

    // Check for explicit TARGET references that conflict with the resolved project
    const explicitTargetRefs = references.filter(r => r.target);
    for (const targetRef of explicitTargetRefs) {
      if (projectCanonical && targetRef.canonical.toLowerCase() !== projectCanonical.toLowerCase()) {
        return {
          project: {
            id: resolvedProject.id,
            slug: resolvedProject.slug,
            name: resolvedProject.name,
            workspace: resolvedProject.workspace_path,
            target_repository: resolvedProject.repository_url || resolvedProject.repo_url,
            canonical_repository: projectCanonical,
            default_branch: resolvedProject.default_branch || 'main'
          },
          repository_references: references,
          execution: {
            project: resolvedProject.slug,
            allowed: false,
            validation_result: 'SCOPE_CONFLICT',
            validation_reason: `Scope conflict: Explicit target repository (${targetRef.url}) does not match selected project ${resolvedProject.slug} (${projectCanonical}). Cross-project modifications require explicit project selection or authorized scope.`,
            scope_conflict: true,
            conflicting_target: targetRef.url
          }
        };
      }
    }

    // Workspace verification (disk & remote check) if workspace exists
    const workspacePath = resolvedProject.workspace_path;
    let workspaceCheckResult = { valid: true };

    if (workspacePath && GitOperations.isGitRepo(workspacePath)) {
      const actualRemote = GitOperations.getRemoteUrl(workspacePath, 'origin');
      const expectedRepo = resolvedProject.repository_url || resolvedProject.repo_url;

      // Ballo vs CodeOrchestrator safeguard
      const isBallo = (resolvedProject.slug && resolvedProject.slug.toLowerCase().includes('ballo')) ||
                      (resolvedProject.name && resolvedProject.name.toLowerCase().includes('ballo'));
      if (isBallo && actualRemote && (actualRemote.includes('codeorchestrator') || actualRemote.includes('coding-orchestrator'))) {
        return {
          project: {
            id: resolvedProject.id,
            slug: resolvedProject.slug,
            name: resolvedProject.name,
            workspace: resolvedProject.workspace_path,
            target_repository: expectedRepo,
            canonical_repository: projectCanonical,
            default_branch: resolvedProject.default_branch || 'main'
          },
          repository_references: references,
          execution: {
            project: resolvedProject.slug,
            allowed: false,
            validation_result: 'WORKSPACE_REMOTE_MISMATCH',
            validation_reason: `Critical repository mismatch: Ballo workspace remote points to codeorchestrator (${actualRemote}). Execution blocked.`,
            scope_conflict: false
          }
        };
      }

      if (expectedRepo && actualRemote) {
        if (!areEquivalentGitUrls(actualRemote, expectedRepo, { allowLocal })) {
          return {
            project: {
              id: resolvedProject.id,
              slug: resolvedProject.slug,
              name: resolvedProject.name,
              workspace: resolvedProject.workspace_path,
              target_repository: expectedRepo,
              canonical_repository: projectCanonical,
              default_branch: resolvedProject.default_branch || 'main'
            },
            repository_references: references,
            execution: {
              project: resolvedProject.slug,
              allowed: false,
              validation_result: 'WORKSPACE_REMOTE_MISMATCH',
              validation_reason: `Repository mismatch: workspace remote (${actualRemote}) does not match project repository (${expectedRepo}).`,
              scope_conflict: false
            }
          };
        }
      }
    }

    return {
      project: {
        id: resolvedProject.id,
        slug: resolvedProject.slug,
        name: resolvedProject.name,
        workspace: resolvedProject.workspace_path,
        target_repository: resolvedProject.repository_url || resolvedProject.repo_url,
        canonical_repository: projectCanonical,
        default_branch: resolvedProject.default_branch || 'main'
      },
      repository_references: references,
      execution: {
        project: resolvedProject.slug,
        allowed: true,
        validation_result: 'PASS',
        validation_reason: null,
        scope_conflict: false
      }
    };
  }

  /**
   * Persists repository reference decisions for auditability and recovery.
   */
  static persistRepositoryReferences(taskId, projectId, references = [], validationResult = 'PASS', validationReason = null) {
    if (!taskId || !projectId || !Array.isArray(references)) return;
    try {
      dbRun('DELETE FROM repository_references WHERE task_id = ?', [taskId]);
    } catch {}
    for (const ref of references) {
      try {
        dbRun(
          `INSERT INTO repository_references (
            id, task_id, project_id, reference_url, canonical_repository,
            reference_role, classification_source, is_target, validation_result,
            validation_reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          [
            randomUUID(),
            taskId,
            projectId,
            ref.url,
            ref.canonical || ref.url,
            ref.role,
            ref.source || 'classifier',
            ref.target ? 1 : 0,
            validationResult,
            validationReason
          ]
        );
      } catch (err) {
        logger.warn({ err: err.message, ref }, 'Failed to persist repository reference');
      }
    }
  }

  /**
   * Fetches persisted repository references for a task or project.
   */
  static getPersistedReferences(taskId) {
    if (!taskId) return [];
    try {
      return dbGet('SELECT * FROM repository_references WHERE task_id = ?', [taskId]);
    } catch {
      return [];
    }
  }

  /**
   * Builds structured # PROJECT CONTEXT handoff header prepended to OpenCode prompt.
   */
  static buildProjectContextPrompt({
    project = null,
    promptText = '',
    references = []
  } = {}) {
    const raw = (promptText || '').trim();
    if (raw.startsWith('# PROJECT CONTEXT')) {
      return raw;
    }

    const lines = [
      '# PROJECT CONTEXT',
      `Target Project: ${project?.slug || project?.name || 'unknown'}`,
      `Target Repository: ${project?.repository_url || project?.repo_url || 'local'}`,
      `Target Workspace: ${project?.workspace_path || 'current'}`,
      `Default Branch: ${project?.default_branch || 'main'}`
    ];

    if (references && references.length > 0) {
      lines.push('Repository Roles:');
      for (const ref of references) {
        lines.push(`- [${ref.role}] ${ref.url} (${ref.canonical || ref.url})`);
      }
    }

    lines.push('');
    lines.push('Execution Policy:');
    lines.push('- All file modifications MUST occur strictly within the target workspace.');
    lines.push('- Starter repositories, templates, and framework dependencies are read-only references; do NOT modify them.');
    lines.push('- Preserve Go module declarations and project-internal imports without automated renaming.');
    lines.push('- Do NOT perform automated git push; modifications will go through human Git review.');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(raw);

    return lines.join('\n');
  }
}
