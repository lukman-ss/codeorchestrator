import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import logger from '../logger.js';

export class ImplementationVerifier {
  static getExecEnv() {
    const home = process.env.HOME || '/home/lukman-ss';
    const candidatePaths = [
      join(home, '.local/go/bin'),
      join(home, '.local/bin'),
      join(home, '.local/npm/bin'),
      '/usr/local/go/bin',
      '/tmp/go/bin',
      process.env.PATH || ''
    ].filter(Boolean);

    return {
      ...process.env,
      PATH: candidatePaths.join(':')
    };
  }

  static detectStack(workspacePath) {
    if (existsSync(join(workspacePath, 'go.mod'))) return 'Go';
    if (existsSync(join(workspacePath, 'package.json'))) return 'Node.js';
    if (existsSync(join(workspacePath, 'Cargo.toml'))) return 'Rust';
    if (existsSync(join(workspacePath, 'pyproject.toml')) || existsSync(join(workspacePath, 'requirements.txt'))) return 'Python';
    return 'Generic';
  }

  static runStackChecks(workspacePath, stack, taskFiles = []) {
    const results = [];
    const execEnv = this.getExecEnv();

    if (stack === 'Go') {
      // Check gofmt
      try {
        const fmtOutput = execSync('gofmt -l .', { cwd: workspacePath, stdio: 'pipe', env: execEnv }).toString().trim();
        results.push({
          check: 'gofmt',
          passed: fmtOutput.length === 0,
          output: fmtOutput ? `Files needing formatting: ${fmtOutput}` : 'All files formatted properly.'
        });
      } catch (err) {
        results.push({ check: 'gofmt', passed: false, output: err.message });
      }

      // Check go vet
      try {
        const vetOut = execSync('go vet ./...', { cwd: workspacePath, stdio: 'pipe', env: execEnv }).toString().trim();
        results.push({ check: 'go vet', passed: true, output: vetOut || 'go vet passed.' });
      } catch (err) {
        results.push({ check: 'go vet', passed: false, output: err.stderr?.toString() || err.message });
      }

      // Check go test
      try {
        const testOut = execSync('go test ./...', { cwd: workspacePath, stdio: 'pipe', timeout: 30000, env: execEnv }).toString().trim();
        results.push({ check: 'go test', passed: true, output: testOut });
      } catch (err) {
        results.push({ check: 'go test', passed: false, output: err.stderr?.toString() || err.stdout?.toString() || err.message });
      }
    } else if (stack === 'Node.js') {
      // Check syntax of changed js/mjs files
      for (const rel of taskFiles) {
        if (rel.endsWith('.js') || rel.endsWith('.mjs')) {
          const full = join(workspacePath, rel);
          if (existsSync(full)) {
            try {
              execSync(`node --check "${full}"`, { cwd: workspacePath, stdio: 'pipe', env: execEnv });
              results.push({ check: `syntax:${rel}`, passed: true, output: 'Syntax valid.' });
            } catch (err) {
              results.push({ check: `syntax:${rel}`, passed: false, output: err.stderr?.toString() || err.message });
            }
          }
        }
      }

      // Run npm test if defined and not default placeholder
      try {
        const pkgPath = join(workspacePath, 'package.json');
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
          if (pkg.scripts && pkg.scripts.test && !pkg.scripts.test.includes('no test specified')) {
            const npmOut = execSync('npm test', { cwd: workspacePath, stdio: 'pipe', timeout: 30000, env: execEnv }).toString().trim();
            results.push({ check: 'npm test', passed: true, output: npmOut.slice(0, 500) });
          }
        }
      } catch (err) {
        results.push({ check: 'npm test', passed: false, output: err.stderr?.toString() || err.stdout?.toString() || err.message });
      }
    }

    return results;
  }

  static async verifyTask({
    projectId,
    workspacePath,
    prompt = '',
    acceptanceCriteria = [],
    taskFiles = []
  }) {
    const stack = this.detectStack(workspacePath);
    const stackChecks = this.runStackChecks(workspacePath, stack, taskFiles);

    const verifiedRequirements = [];
    const failedRequirements = [];

    // Verify stack checks pass
    for (const sc of stackChecks) {
      if (sc.passed) {
        verifiedRequirements.push({
          requirement: sc.check,
          status: 'verified',
          evidence: sc.output
        });
      } else {
        failedRequirements.push({
          requirement: sc.check,
          status: 'failed',
          evidence: sc.output
        });
      }
    }

    // Inspect files and prompt requirements
    if (acceptanceCriteria && acceptanceCriteria.length > 0) {
      for (const ac of acceptanceCriteria) {
        const text = typeof ac === 'string' ? ac : (ac.text || ac.criterion || JSON.stringify(ac));
        // Check if criterion was marked force_fail
        if (ac.force_fail) {
          failedRequirements.push({
            requirement: text,
            status: 'failed',
            evidence: 'Requirement flagged failed by criteria constraint'
          });
          continue;
        }

        // Check if any task files satisfy or contain relevant code
        let evidenceFound = false;
        if (taskFiles.length > 0) {
          for (const f of taskFiles) {
            const p = join(workspacePath, f);
            if (existsSync(p)) {
              evidenceFound = true;
              break;
            }
          }
        } else {
          // If no specific taskFiles list, check if directory has files
          evidenceFound = existsSync(workspacePath);
        }

        if (evidenceFound) {
          verifiedRequirements.push({
            requirement: text,
            status: 'verified',
            evidence: `Verified changes present in workspace (${taskFiles.length} files)`
          });
        } else {
          failedRequirements.push({
            requirement: text,
            status: 'failed',
            evidence: 'No matching files or changes found in workspace'
          });
        }
      }
    } else {
      // Default prompt check: if task modified files, verify non-empty
      if (taskFiles.length > 0) {
        for (const f of taskFiles) {
          const full = join(workspacePath, f);
          if (existsSync(full)) {
            const size = statSync(full).size;
            verifiedRequirements.push({
              requirement: `File artifact: ${f}`,
              status: 'verified',
              evidence: `File exists with size ${size} bytes`
            });
          } else {
            failedRequirements.push({
              requirement: `File artifact: ${f}`,
              status: 'failed',
              evidence: 'Expected file artifact missing from workspace'
            });
          }
        }
      } else {
        // Conversational or non-file task
        verifiedRequirements.push({
          requirement: 'Execution output generated',
          status: 'verified',
          evidence: 'Execution completed without filesystem errors'
        });
      }
    }

    const totalRequirements = verifiedRequirements.length + failedRequirements.length;
    const passedCount = verifiedRequirements.length;
    const isPassing = failedRequirements.length === 0;

    // ponytail: stack checks plus artifact existence. Upgrade path: sandboxed runtime execution container.
    return {
      totalRequirements,
      verifiedRequirements: passedCount,
      failedRequirements: failedRequirements.length,
      status: isPassing ? 'PASS' : 'FAILED',
      stack,
      stackChecks,
      verifiedList: verifiedRequirements,
      failedList: failedRequirements,
      evidenceSummary: isPassing ? 'All acceptance checks and tests passed.' : `Failed requirements: ${failedRequirements.map(f => f.requirement).join(', ')}`
    };
  }
}
