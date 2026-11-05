import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsService } from '../src/services/settings-service.js';
import { parseSshConfig } from '../src/services/git-auth.js';
import { updateProject, getProject } from '../src/services/project-service.js';

test('SettingsService: get, set, and setMultiple persist values in SQLite', () => {
  SettingsService.set('test_key_foo', 'test_value_bar');
  assert.equal(SettingsService.get('test_key_foo'), 'test_value_bar');

  SettingsService.setMultiple({
    auto_approve_level: 'HIGH',
    task_timeout_seconds: '7200',
    reasoning_effort: 'high'
  });

  const all = SettingsService.getAll();
  assert.equal(all.auto_approve_level, 'HIGH');
  assert.equal(all.task_timeout_seconds, '7200');
  assert.equal(all.reasoning_effort, 'high');
});

test('GitAuth unit: parseSshConfig parses ~/.ssh/config aliases', () => {
  const aliases = parseSshConfig();
  assert.ok(Array.isArray(aliases));
  if (aliases.length > 0) {
    const first = aliases[0];
    assert.ok(Array.isArray(first.hosts));
  }
});

test('ProjectService: updateProject updates default_model and metadata effort', () => {
  // Test updating project model override
  const proj = updateProject('ballo', {
    default_model: '9router/ag/claude-sonnet-4-6',
    metadata: { effort: 'high' }
  });

  assert.equal(proj.default_model, '9router/ag/claude-sonnet-4-6');
  const meta = JSON.parse(proj.metadata_json || '{}');
  assert.equal(meta.effort, 'high');
});
