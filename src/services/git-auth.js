// ponytail: stdlib git credential and SSH detection; upgrade to libgit2 bindings if granular multi-key management needed.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Detect Git authentication state: SSH key connectivity vs token/login.
 */
export function detectGitAuth({ sshKeyPath, timeout = 4000, testSsh = true } = {}) {
  const result = {
    connected: false,
    authType: 'none', // 'ssh' | 'token' | 'none'
    status: 'NOT CONNECTED',
    gitUser: '',
    gitEmail: '',
    sshUser: null,
    sshKeyPath: sshKeyPath || null,
    hasToken: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN)
  };

  // 1. Read git user and email
  try {
    result.gitUser = execSync('git config user.name', { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    result.gitUser = process.env.GIT_USER_NAME || '';
  }
  try {
    result.gitEmail = execSync('git config user.email', { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    result.gitEmail = process.env.GIT_USER_EMAIL || '';
  }

  // 2. Discover candidate SSH key if none specified
  if (!result.sshKeyPath) {
    const sshDir = join(homedir(), '.ssh');
    if (existsSync(sshDir)) {
      try {
        const files = readdirSync(sshDir);
        const keys = files.filter(f => f.startsWith('id_') && !f.endsWith('.pub') && !f.endsWith('.old'));
        const preferred = keys.find(k => k.includes('orchestrator') || k.includes('ed25519')) || keys[0];
        if (preferred) {
          result.sshKeyPath = join(sshDir, preferred);
        }
      } catch {}
    }
  }

  // 3. Test SSH connection
  if (testSsh) {
    try {
      const keyOpt = result.sshKeyPath ? `-i "${result.sshKeyPath}"` : '';
      const cmd = `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=3 ${keyOpt} git@github.com`;
      execSync(cmd, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const combined = (err.stdout || '') + (err.stderr || '') + (err.message || '');
      const match = combined.match(/Hi\s+([a-zA-Z0-9_-]+)!/i);
      if (match) {
        result.connected = true;
        result.authType = 'ssh';
        result.sshUser = match[1];
        result.status = `CONNECTED (SSH: ${match[1]})`;
        return result;
      }
    }
  }

  // 4. Token fallback
  if (result.hasToken) {
    result.connected = true;
    result.authType = 'token';
    result.status = 'CONNECTED (TOKEN)';
    return result;
  }

  // 5. Configured locally but not authenticated upstream
  if (result.gitUser) {
    result.status = `CONFIGURED (${result.gitUser})`;
  } else {
    result.status = 'NOT CONNECTED';
  }

  return result;
}

/**
 * Test SSH authentication against remote git host.
 */
export function testSshConnection(keyPath, host = 'git@github.com') {
  if (keyPath && !existsSync(keyPath)) {
    return { ok: false, user: null, message: `Key file not found: ${keyPath}` };
  }
  try {
    const keyOpt = keyPath ? `-i "${keyPath}" -o IdentitiesOnly=yes` : '';
    const cmd = `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=3 ${keyOpt} ${host}`;
    execSync(cmd, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, user: null, message: 'SSH handshake succeeded' };
  } catch (err) {
    const combined = (err.stdout || '') + (err.stderr || '') + (err.message || '');
    const match = combined.match(/Hi\s+([a-zA-Z0-9_-]+)!/i);
    if (match) {
      return { ok: true, user: match[1], message: `Successfully authenticated as ${match[1]}` };
    }
    return { ok: false, user: null, message: combined.trim() || err.message };
  }
}

/**
 * Update global git user name and email.
 */
export function setGitUser({ name, email } = {}) {
  if (name) {
    execSync(`git config --global user.name "${name.replace(/"/g, '')}"`, { stdio: 'ignore' });
  }
  if (email) {
    execSync(`git config --global user.email "${email.replace(/"/g, '')}"`, { stdio: 'ignore' });
  }
}
