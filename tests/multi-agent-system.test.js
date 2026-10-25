import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import WebSocket from 'ws';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WorktreeManager } from '../src/services/worktree-manager.js';
import { RequirementExtractor } from '../src/services/requirement-extractor.js';
import { ParallelScheduler } from '../src/services/parallel-scheduler.js';

const BASE = 'http://127.0.0.1:4000';
const WS_BASE = 'ws://127.0.0.1:4000/ws';
const TOKEN = 'test-token-123';

const req = (path, method = 'GET', body = null) => {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
    const opts = { method, headers };
    const r = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
};

test('Requirement Extractor parses complex Markdown lists correctly', () => {
  const prompt = `
# Project Plan
1. Implement auth middleware with JWT support
   Acceptance criteria: must validate Bearer token
2. Create DB migration for users table
   Acceptance criteria: table has id, email, password_hash
* Optional: add email notification service
`;
  const reqs = RequirementExtractor.extract(prompt);
  assert.equal(reqs.length, 3);
  assert.equal(reqs[0].requirement_id, 'REQ-001');
  assert.equal(reqs[0].mandatory, true);
  assert.equal(reqs[2].mandatory, false);
});

test('Worktree Manager handles isolation for Git repositories', () => {
  const testDir = '/tmp/test-git-repo-' + Date.now();
  mkdirSync(testDir, { recursive: true });
  execSync('git init', { cwd: testDir });
  execSync('git config user.name "Tester"', { cwd: testDir });
  execSync('git config user.email "test@example.com"', { cwd: testDir });
  writeFileSync(join(testDir, 'README.md'), 'Initial');
  execSync('git add -A && git commit -m "init"', { cwd: testDir });

  const wt = WorktreeManager.createWorkerWorktree({
    canonicalPath: testDir,
    projectSlug: 'test-slug',
    jobId: 'job-123',
    subtaskId: 'sub-456'
  });

  assert.equal(wt.isWorktree, true);
  assert.ok(existsSync(wt.path));

  WorktreeManager.cleanupWorktree(testDir, wt.path, wt.branch);
  assert.equal(existsSync(wt.path), false);
  rmSync(testDir, { recursive: true, force: true });
});

test('ParallelScheduler concurrency and dependency checks', () => {
  assert.equal(ParallelScheduler.hasCapacity('worker'), true);
  const claimed = ParallelScheduler.claimSlot('worker');
  assert.equal(claimed, true);
  ParallelScheduler.releaseSlot('worker');
  assert.equal(ParallelScheduler.getGlobalRunning(), 0);
});

test('ParallelScheduler validates valid transitions', () => {
  assert.equal(ParallelScheduler.validateSubtaskStatusTransition('pending', 'queued'), true);
  assert.equal(ParallelScheduler.validateSubtaskStatusTransition('running', 'implementation_done'), true);
  assert.equal(ParallelScheduler.validateSubtaskStatusTransition('completed', 'running'), false);
});
