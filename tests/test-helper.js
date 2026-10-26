import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';

export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export async function startTestServer(options = {}) {
  const token = options.token || 'test-token-123';
  const port = options.port || (await getFreePort());
  const baseTmp = existsSync('/tmp/antigravity') ? '/tmp/antigravity' : tmpdir();
  const testDir = mkdtempSync(join(baseTmp, 'test-orch-'));
  const dbPath = join(testDir, 'orchestrator.db');
  const workspaceRoot = join(testDir, 'workspace');
  const sessionRuntimeRoot = join(testDir, 'session-runtime');

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATABASE_PATH: dbPath,
    WORKSPACE_ROOT: workspaceRoot,
    SESSION_RUNTIME_ROOT: sessionRuntimeRoot,
    ORCHESTRATOR_API_TOKEN: token,
    REQUIRE_AUTH: 'true',
    NODE_ENV: 'test',
    ...options.env
  };

  const childServer = spawn('node', ['src/server.js'], {
    env,
    stdio: 'ignore'
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  // Poll /health until server is up
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    try {
      const res = await new Promise((resResolve, resReject) => {
        const req = http.get(`${baseUrl}/health`, (resp) => {
          resResolve(resp.statusCode);
        });
        req.on('error', resReject);
      });
      if (res === 200) {
        ready = true;
        break;
      }
    } catch {}
  }

  if (!ready) {
    childServer.kill('SIGKILL');
    rmSync(testDir, { recursive: true, force: true });
    throw new Error(`Test server failed to start on ${baseUrl}`);
  }

  const req = (path, method = 'GET', body = null, headers = {}) => {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const reqHeaders = {
        Authorization: `Bearer ${token}`,
        ...headers
      };
      if (body !== null && body !== undefined) {
        reqHeaders['Content-Type'] = 'application/json';
      }
      const opts = { method, headers: reqHeaders };
      const r = http.request(url, opts, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      r.on('error', reject);
      if (body) {
        r.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      r.end();
    });
  };

  const cleanup = async () => {
    if (childServer) {
      try {
        childServer.kill('SIGTERM');
      } catch {}
      await new Promise(r => setTimeout(r, 300));
      try {
        childServer.kill('SIGKILL');
      } catch {}
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  };

  return {
    port,
    baseUrl,
    token,
    dbPath,
    workspaceRoot,
    sessionRuntimeRoot,
    testDir,
    childServer,
    env,
    req,
    cleanup
  };
}
