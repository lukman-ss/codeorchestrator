import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { startTestServer } from './test-helper.js';

let serverContext;
let BASE;
let TOKEN;
let tempCliDir;

const CLI_PATH = resolve('bin/co.js');

function runCli(args = [], customEnv = {}) {
  const env = {
    ...process.env,
    ORCHESTRATOR_API_URL: BASE,
    ORCHESTRATOR_API_TOKEN: TOKEN,
    HOME: tempCliDir,
    ...customEnv
  };
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd: tempCliDir,
      env,
      encoding: 'utf8'
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status || 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : err.message
    };
  }
}

before(async () => {
  serverContext = await startTestServer();
  BASE = serverContext.baseUrl;
  TOKEN = serverContext.token;
  const baseTmp = existsSync('/tmp/antigravity') ? '/tmp/antigravity' : tmpdir();
  tempCliDir = mkdtempSync(join(baseTmp, 'cli-test-'));
});

after(async () => {
  if (tempCliDir && existsSync(tempCliDir)) {
    try { rmSync(tempCliDir, { recursive: true, force: true }); } catch {}
  }
  if (serverContext) {
    await serverContext.cleanup();
  }
});

test('CLI: --help displays usage guide', () => {
  const res = runCli(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage: co/);
  assert.match(res.stdout, /project list/);
  assert.match(res.stdout, /run <prompt>/);
});

test('CLI: project create adds new project and activates it', () => {
  const res = runCli(['project', 'create', 'test-cli-project', '--slug', 'cli-slug-test']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Project created: test-cli-project/);
  assert.match(res.stdout, /Active project set to: cli-slug-test/);
});

test('CLI: project current reports active project', () => {
  const res = runCli(['project', 'current']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Active Project: test-cli-project/);
  assert.match(res.stdout, /Slug:\s+cli-slug-test/);
});

test('CLI: project list marks active project with [ACTIVE]', () => {
  const res = runCli(['project', 'list']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\* test-cli-project/);
  assert.match(res.stdout, /\[ACTIVE\]/);
});

test('CLI: run falls back to active project and submits task', () => {
  const res = runCli(['run', 'say hello from cli']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Task submitted:/);
  assert.match(res.stdout, /Project:\s+cli-slug-test/);
});

test('CLI: job submits multi-agent job', () => {
  const res = runCli(['job', 'implement sample feature']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Job submitted:/);
  assert.match(res.stdout, /Project:\s+cli-slug-test/);
});

test('CLI: status queries task status', () => {
  // Submit a task first
  const runRes = runCli(['run', 'status check task', '--json']);
  assert.equal(runRes.status, 0);
  const task = JSON.parse(runRes.stdout);
  assert.ok(task.id);

  const statRes = runCli(['status', task.id]);
  assert.equal(statRes.status, 0, statRes.stderr);
  assert.match(statRes.stdout, /Type:\s+TASK/);
  assert.match(statRes.stdout, new RegExp(task.id));
});

test('CLI: approvals lists pending approvals cleanly', () => {
  const res = runCli(['approvals']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /No pending approvals/);
});

test('CLI: tui in non-interactive environment throws expected error', () => {
  const res = runCli(['tui']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /TUI requires an interactive TTY terminal/);
});

test('CLI: approve decides a pending approval', () => {
  const db = new Database(serverContext.dbPath);
  // Get created project id
  const project = db.prepare("SELECT id FROM projects WHERE slug = 'cli-slug-test'").get();
  assert.ok(project);

  const approvalId = 'appr-cli-test-1';
  db.prepare(`
    INSERT INTO git_approval_requests (
      id, project_id, repository_identity, target_branch, reviewed_revision, status,
      diff_summary_json, files_changed_json, proposed_commit_message, created_at
    ) VALUES (?, ?, ?, ?, 'HEAD', 'pending', '{}', '[]', 'test commit', datetime('now'))
  `).run(approvalId, project.id, 'local', 'main');
  db.close();

  // Test approvals listing
  const listRes = runCli(['approvals']);
  assert.equal(listRes.status, 0, listRes.stderr);
  assert.match(listRes.stdout, /Pending Approvals \(1\)/);
  assert.match(listRes.stdout, new RegExp(approvalId));

  // Test decision
  const decRes = runCli(['approve', approvalId, 'keep_local']);
  assert.equal(decRes.status, 0, decRes.stderr);
  assert.match(decRes.stdout, /Approval appr-cli-test-1 decided: keep_local/);
});

test('CLI: tasks lists tasks in tabular columns', () => {
  const res = runCli(['tasks']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /STATUS \| PROJECT\s+\| PROMPT/);
});

