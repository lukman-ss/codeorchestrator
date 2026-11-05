// ponytail: stdlib git credential and SSH detection; upgrade to libgit2 bindings if granular multi-key management needed.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Parse ~/.ssh/config for Host aliases, hostnames, and identity keys.
 */
export function parseSshConfig(configPath = join(homedir(), '.ssh/config')) {
  if (!existsSync(configPath)) return [];
  try {
    const content = readFileSync(configPath, 'utf8');
    const lines = content.split('\n');
    const hosts = [];
    let curHost = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const [key, ...vals] = line.split(/\s+/);
      const val = vals.join(' ');

      if (key.toLowerCase() === 'host') {
        curHost = { hosts: vals, hostName: null, user: null, identityFile: null };
        hosts.push(curHost);
      } else if (curHost) {
        if (key.toLowerCase() === 'hostname') curHost.hostName = val;
        else if (key.toLowerCase() === 'user') curHost.user = val;
        else if (key.toLowerCase() === 'identityfile') {
          curHost.identityFile = val.startsWith('~') ? val.replace('~', homedir()) : val;
        }
      }
    }
    return hosts;
  } catch {
    return [];
  }
}

/**
 * Detect Git authentication state: SSH key connectivity vs token/login.
 */
export function detectGitAuth({ sshKeyPath, timeout = 4000, testSsh = true, host } = {}) {
  const result = {
    connected: false,
    authType: 'none', // 'ssh' | 'token' | 'none'
    status: 'NOT CONNECTED',
    gitUser: '',
    gitEmail: '',
    sshUser: null,
    sshKeyPath: sshKeyPath || null,
    sshAliases: parseSshConfig(),
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

  // 2. Discover candidate SSH key: check ssh_config aliases first, then ~/.ssh
  if (!result.sshKeyPath) {
    const configAlias = result.sshAliases.find(a => a.identityFile && existsSync(a.identityFile));
    if (configAlias) {
      result.sshKeyPath = configAlias.identityFile;
    } else {
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
  }

  // 3. Test SSH connection
  if (testSsh) {
    const targetHost = host || (result.sshAliases.some(a => a.hosts.includes('github-coding')) ? 'git@github-coding' : 'git@github.com');
    const testResult = testSshConnection(result.sshKeyPath, targetHost, timeout);
    if (testResult.ok && testResult.user) {
      result.connected = true;
      result.authType = 'ssh';
      result.sshUser = testResult.user;
      result.status = `CONNECTED (SSH: ${testResult.user})`;
      return result;
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
export function testSshConnection(keyPath, host = 'git@github.com', timeout = 5000) {
  if (keyPath && !existsSync(keyPath)) {
    return { ok: false, user: null, message: `Key file not found: ${keyPath}` };
  }
  try {
    const keyOpt = keyPath ? `-i "${keyPath}" -o IdentitiesOnly=yes` : '';
    const cmd = `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=3 ${keyOpt} ${host}`;
    execSync(cmd, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
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
