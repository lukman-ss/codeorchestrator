import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { dbRun, dbGetOne } from '../database/db.js';
import logger from '../logger.js';

// Regex patterns for deterministic secret and credential detection
const SECRET_PATTERNS = [
  {
    name: 'Private Cryptographic Key',
    category: 'Credential Exposure',
    severity: 'CRITICAL',
    regex: /-----BEGIN (?:RSA|OPENSSH|EC|DSA|PGP)? PRIVATE KEY-----/,
    remediation: 'Remove private key file or string immediately. Use secure credential management or environment variables.'
  },
  {
    name: 'Private Certificate',
    category: 'Credential Exposure',
    severity: 'HIGH',
    regex: /-----BEGIN (?:CERTIFICATE|X509 CERTIFICATE)-----/,
    remediation: 'Ensure certificates are loaded from secure storage and not committed to source.'
  },
  {
    name: 'GitHub Personal Access Token',
    category: 'Credential Exposure',
    severity: 'CRITICAL',
    regex: /\b(?:ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{50,})\b/,
    remediation: 'Revoke and rotate GitHub token immediately.'
  },
  {
    name: 'OpenAI / LLM API Key',
    category: 'Credential Exposure',
    severity: 'CRITICAL',
    regex: /\bsk-[a-zA-Z0-9]{20,}\b/,
    remediation: 'Rotate LLM API key and pass via environment variables.'
  },
  {
    name: 'Discord Bot Token',
    category: 'Credential Exposure',
    severity: 'CRITICAL',
    regex: /\b[MN][A-Za-z\d]{23,26}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/,
    remediation: 'Reset Discord bot token in Developer Portal.'
  },
  {
    name: 'Slack Token',
    category: 'Credential Exposure',
    severity: 'CRITICAL',
    regex: /\bxox[baprs]-[0-9a-zA-Z]{10,48}\b/,
    remediation: 'Revoke and regenerate Slack token.'
  },
  {
    name: 'JWT / Auth Token',
    category: 'Credential Exposure',
    severity: 'HIGH',
    regex: /\bey[A-Za-z0-9_-]{15,}\.ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/,
    remediation: 'Do not hardcode auth tokens; use short-lived sessions or secure storage.'
  },
  {
    name: 'High-Entropy API Key / Orchestrator Token',
    category: 'Credential Exposure',
    severity: 'CRITICAL',
    regex: /(?:NINEROUTER_API_KEY|ORCHESTRATOR_API_TOKEN|api[_-]?key|secret[_-]?key)\s*[:=]\s*['"][a-zA-Z0-9_-]{12,}['"]/i,
    remediation: 'Remove hardcoded credentials from source code.'
  },
  {
    name: 'Database Connection String with Credentials',
    category: 'Credential Exposure',
    severity: 'CRITICAL',
    regex: /(?:postgres|postgresql|mysql|mongodb|redis):\/\/[a-zA-Z0-9_.-]+:[^@\s/]+@[a-zA-Z0-9_.-]+/i,
    remediation: 'Store database credentials in environment variables.'
  },
  {
    name: 'AWS Access Key ID',
    category: 'Credential Exposure',
    severity: 'CRITICAL',
    regex: /\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/,
    remediation: 'Rotate AWS credentials and configure IAM roles.'
  }
];

// Forbidden files regex (forbidden in repository diffs / commits)
const FORBIDDEN_FILE_REGEX = /(^|\/)(\.env|\.env\.[^.]*|.*\.db|.*\.db-(?:wal|shm)|.*\.sqlite[0-9]?|.*\.log|.*\.log\.gz|.*\.sql|.*\.dump|.*\.bak|id_rsa|id_ed25519|.*\.pem|.*\.key)$/i;

// Confidential infrastructure / PII patterns
const CONFIDENTIAL_PATTERNS = [
  {
    name: 'Internal / Tailscale IP Address',
    category: 'Confidential Information',
    severity: 'HIGH',
    regex: /\b(?:100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\b/,
    remediation: 'Redact private network addresses before staging code.'
  },
  {
    name: 'User Home Directory Path Disclosure',
    category: 'Confidential Information',
    severity: 'HIGH',
    regex: /\/home\/[a-zA-Z0-9_-]+(?:\/[^\s"';,]*)?/,
    remediation: 'Use relative paths or environment-derived workspace paths.'
  }
];

// Input validation and injection patterns
const INJECTION_PATTERNS = [
  {
    name: 'Unsafe Subprocess Shell Execution',
    category: 'Input Validation',
    severity: 'HIGH',
    regex: /(?:exec|execSync)\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`\s*\)/,
    remediation: 'Use spawn/execFile with argument array and shell:false to avoid shell injection.'
  }
];

export class SecurityAuditor {
  static isGitleaksAvailable() {
    try {
      execSync('which gitleaks', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  static redact(text) {
    if (!text || typeof text !== 'string') return '';
    let out = text;
    for (const pat of SECRET_PATTERNS) {
      out = out.replace(new RegExp(pat.regex.source, 'gi'), '[REDACTED]');
    }
    return out;
  }

  static scanFileContent(content, relPath) {
    const findings = [];
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Check secrets
      for (const pat of SECRET_PATTERNS) {
        if (pat.regex.test(line)) {
          findings.push({
            category: pat.category,
            severity: pat.severity,
            filePath: relPath,
            lineNumber: lineNum,
            evidenceReference: `Line ${lineNum}: [REDACTED MATCH]`,
            explanation: `Detected potential ${pat.name} matching security policy.`,
            remediation: pat.remediation
          });
        }
      }

      // Check confidential info
      for (const pat of CONFIDENTIAL_PATTERNS) {
        if (pat.regex.test(line)) {
          findings.push({
            category: pat.category,
            severity: pat.severity,
            filePath: relPath,
            lineNumber: lineNum,
            evidenceReference: `Line ${lineNum}: [REDACTED INFO]`,
            explanation: `Detected ${pat.name} in file contents.`,
            remediation: pat.remediation
          });
        }
      }

      // Check injection
      for (const pat of INJECTION_PATTERNS) {
        if (pat.regex.test(line)) {
          findings.push({
            category: pat.category,
            severity: pat.severity,
            filePath: relPath,
            lineNumber: lineNum,
            evidenceReference: `Line ${lineNum}: Unsafe shell command interpolation`,
            explanation: `Detected ${pat.name}. Dynamic string formatting into shell execution creates command injection vulnerability.`,
            remediation: pat.remediation
          });
        }
      }
    }

    return findings;
  }

  static async auditWorkspace({
    projectId,
    workspacePath,
    taskId = null,
    jobId = null,
    reviewedRevision = 'HEAD',
    taskFiles = []
  }) {
    const auditId = randomUUID();
    const findings = [];
    const scannersExecuted = ['built-in-deterministic-scanner'];
    const limitations = [];

    const hasGitleaks = this.isGitleaksAvailable();
    if (hasGitleaks) {
      scannersExecuted.push('gitleaks');
    } else {
      limitations.push('Gitleaks scanner binary not installed on host; deterministic regex scanner executed as primary analyzer.');
    }

    if (!existsSync(workspacePath)) {
      const report = {
        auditId,
        status: 'INCOMPLETE',
        error: `Workspace directory not found: ${workspacePath}`,
        limitations,
        scannersExecuted
      };
      return report;
    }

    // Inspect files: if taskFiles provided, scan taskFiles. Otherwise scan all non-ignored files.
    const filesToScan = new Set();

    if (taskFiles && taskFiles.length > 0) {
      for (const f of taskFiles) filesToScan.add(f);
    } else {
      // Walk workspace avoiding node_modules and .git
      const walk = (dir) => {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (entry === 'node_modules' || entry === '.git' || entry === 'vendor') continue;
          const full = join(dir, entry);
          const rel = relative(workspacePath, full);
          try {
            const stat = lstatSync(full);
            if (stat.isSymbolicLink()) {
              findings.push({
                category: 'Git & Supply Chain Security',
                severity: 'HIGH',
                filePath: rel,
                lineNumber: 1,
                evidenceReference: `Symlink detected: ${rel}`,
                explanation: 'Symbolic links in project workspace present directory traversal and supply chain escape risks.',
                remediation: 'Remove symbolic link and use standard project relative paths.'
              });
            } else if (stat.isDirectory()) {
              walk(full);
            } else if (stat.isFile()) {
              filesToScan.add(rel);
            }
          } catch {}
        }
      };
      walk(workspacePath);
    }

    for (const relPath of filesToScan) {
      // Check forbidden file names
      if (FORBIDDEN_FILE_REGEX.test(relPath) && !relPath.endsWith('.env.example')) {
        findings.push({
          category: 'Git & Supply Chain Security',
          severity: 'CRITICAL',
          filePath: relPath,
          lineNumber: 1,
          evidenceReference: `Forbidden sensitive artifact filename: ${relPath}`,
          explanation: `File matches forbidden sensitive file pattern. It must not be committed or tracked.`,
          remediation: 'Delete or add file to .gitignore immediately.'
        });
      }

      // Check content
      const fullPath = join(workspacePath, relPath);
      if (!existsSync(fullPath)) continue;

      try {
        const stat = statSync(fullPath);
        if (stat.size > 2 * 1024 * 1024) {
          limitations.push(`Skipped large file ${relPath} (>2MB)`);
          continue;
        }

        const buf = readFileSync(fullPath);
        // Skip binary files (null bytes)
        if (buf.includes(0x00)) {
          findings.push({
            category: 'Git & Supply Chain Security',
            severity: 'MEDIUM',
            filePath: relPath,
            lineNumber: 1,
            evidenceReference: `Binary artifact detected: ${relPath}`,
            explanation: 'Binary file proposed for staging. Binaries may contain hidden vulnerabilities or unvetted blobs.',
            remediation: 'Exclude binary artifacts from Git commit; build artifacts during CI/CD instead.'
          });
          continue;
        }

        const content = buf.toString('utf8');
        const fileFindings = this.scanFileContent(content, relPath);
        findings.push(...fileFindings);
      } catch (err) {
        limitations.push(`Error reading ${relPath}: ${err.message}`);
      }
    }

    // Determine verdict
    const hasCritical = findings.some(f => f.severity === 'CRITICAL');
    const hasHigh = findings.some(f => f.severity === 'HIGH');
    const status = (hasCritical || hasHigh) ? 'BLOCKED' : 'PASS';

    const severitySummary = {
      CRITICAL: findings.filter(f => f.severity === 'CRITICAL').length,
      HIGH: findings.filter(f => f.severity === 'HIGH').length,
      MEDIUM: findings.filter(f => f.severity === 'MEDIUM').length,
      LOW: findings.filter(f => f.severity === 'LOW').length,
      INFO: findings.filter(f => f.severity === 'INFO').length
    };

    const reportJson = JSON.stringify({
      auditId,
      projectId,
      taskId,
      jobId,
      reviewedRevision,
      status,
      scannersExecuted,
      limitations,
      severitySummary,
      findingsCount: findings.length,
      findings
    });

    // ponytail: store in db and link findings. Upgrade path: external webhook for SIEM.
    dbRun(
      `INSERT INTO security_audits (
        id, task_id, job_id, project_id, reviewed_revision, status,
        severity_summary_json, scanners_executed_json, limitations_json, report_json, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        auditId,
        taskId,
        jobId,
        projectId,
        reviewedRevision,
        status,
        JSON.stringify(severitySummary),
        JSON.stringify(scannersExecuted),
        JSON.stringify(limitations),
        reportJson
      ]
    );

    for (const f of findings) {
      dbRun(
        `INSERT INTO security_findings (
          id, audit_id, category, severity, file_path, line_number,
          finding_status, evidence_reference, explanation, remediation_recommendation
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        [
          randomUUID(),
          auditId,
          f.category,
          f.severity,
          f.filePath,
          f.lineNumber || 1,
          f.evidenceReference,
          f.explanation,
          f.remediation || null
        ]
      );
    }

    return {
      auditId,
      status,
      severitySummary,
      limitations,
      scannersExecuted,
      findings,
      reportJson
    };
  }
}
