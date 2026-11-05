import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGitAuth, testSshConnection } from '../src/services/git-auth.js';

test('GitAuth unit: detectGitAuth reports credentials and status', () => {
  const result = detectGitAuth({ testSsh: false });
  assert.ok(result);
  assert.equal(typeof result.connected, 'boolean');
  assert.equal(typeof result.status, 'string');
  assert.ok(['ssh', 'token', 'none'].includes(result.authType));
  assert.equal(typeof result.gitUser, 'string');
  assert.equal(typeof result.gitEmail, 'string');
});

test('GitAuth unit: detectGitAuth with token environment fallback', () => {
  const originalToken = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = 'ghp_synthetic_token_for_testing';
    const result = detectGitAuth({ testSsh: false });
    assert.equal(result.connected, true);
    assert.equal(result.authType, 'token');
    assert.equal(result.status, 'CONNECTED (TOKEN)');
  } finally {
    if (originalToken !== undefined) {
      process.env.GITHUB_TOKEN = originalToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  }
});

test('GitAuth unit: testSshConnection handles invalid key path gracefully', () => {
  const result = testSshConnection('/tmp/non_existent_key_12345');
  assert.ok(result);
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, 'string');
});
