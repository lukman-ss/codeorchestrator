import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TerminalUi,
  fit,
  progressBar,
  visibleLen,
  stripAnsi,
  wrapText,
  isEligibleForAutoApprove,
  getImpactLevel,
  hasSensitiveOrBreaking
} from '../bin/tui.js';

test('TUI unit: stripAnsi and visibleLen handle color codes', () => {
  const colored = '\x1b[32m\x1b[1mHello World\x1b[0m';
  assert.equal(stripAnsi(colored), 'Hello World');
  assert.equal(visibleLen(colored), 11);
});

test('TUI unit: fit truncates with ellipsis or pads', () => {
  assert.equal(fit('abc', 5), 'abc  ');
  assert.equal(fit('hello world', 6), 'hello…');
});

test('TUI unit: progressBar renders gauge correctly', () => {
  const bar = progressBar(50, 10);
  assert.match(bar, /50%/);
  assert.equal(stripAnsi(bar).trim(), '█████░░░░░ 50%');
});

test('TUI unit: header renders tabs and online status', () => {
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'ballo',
    setActiveProject: () => {}
  });

  ui.health = { status: 'ok' };
  ui.projects = [{ slug: 'ballo', name: 'ballo' }];
  ui.tabIndex = 0;

  const header = ui.renderHeader(80);
  assert.match(header, /CodeOrchestrator/);
  assert.match(header, /ONLINE/);
  assert.match(header, /1\. Projects/);
});

test('TUI unit: key navigation cycles selected index and tabs', () => {
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'ballo',
    setActiveProject: () => {}
  });

  ui.projects = [{ slug: 'p1', name: 'p1' }, { slug: 'p2', name: 'p2' }];
  ui.tabIndex = 0;
  ui.selected = 0;

  ui.handleKey('j', { name: 'down' });
  assert.equal(ui.selected, 1);

  ui.handleKey('', { name: 'tab' });
  assert.equal(ui.tabIndex, 1); // tasks tab
  assert.equal(ui.tab, 'tasks');

  ui.handleKey('`', {});
  assert.equal(ui.tabIndex, 0); // projects tab (back to left)
  assert.equal(ui.tab, 'projects');

  ui.handleKey('`', {});
  assert.equal(ui.tabIndex, 4); // wrap-around left to settings tab
  assert.equal(ui.tab, 'settings');

  ui.handleKey('', { name: 'tab' });
  assert.equal(ui.tabIndex, 0); // wrap-around right to projects tab
  assert.equal(ui.tab, 'projects');
});

test('TUI unit: filter query narrows displayed projects', () => {
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'ballo',
    setActiveProject: () => {}
  });

  ui.projects = [
    { slug: 'ballo-orm', name: 'ballo-orm' },
    { slug: 'ballo-http', name: 'ballo-http' },
    { slug: 'other-proj', name: 'other-proj' }
  ];
  ui.tabIndex = 0;

  ui.filter = 'http';
  const filtered = ui.getFilteredItems();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].slug, 'ballo-http');
});

test('TUI unit: action switches active project', async () => {
  let saved = null;
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'p1',
    setActiveProject: (s) => { saved = s; }
  });

  ui.projects = [{ slug: 'p1', name: 'p1' }, { slug: 'p2', name: 'p2' }];
  ui.tabIndex = 0;
  ui.selected = 1;

  await ui.handleAction();
  assert.equal(saved, 'p2');
  assert.equal(ui.activeSlug, 'p2');
});

test('TUI unit: scrollable modal scrolling works', () => {
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'p1',
    setActiveProject: () => {}
  });

  ui.modal = {
    title: 'Test Log',
    type: 'info',
    scrollOffset: 0,
    lines: Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`)
  };

  ui.handleKey('j', { name: 'down' });
  assert.equal(ui.modal.scrollOffset, 1);

  ui.handleKey('k', { name: 'up' });
  assert.equal(ui.modal.scrollOffset, 0);
});

test('TUI unit: confirmation modal triggers callback on y', () => {
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'p1',
    setActiveProject: () => {}
  });

  let confirmed = false;
  ui.openConfirmModal('Confirm', 'Are you sure?', () => { confirmed = true; });
  assert.ok(ui.modal);

  ui.handleKey('y', { name: 'y' });
  assert.equal(confirmed, true);
  assert.equal(ui.modal, null);
});

test('TUI unit: workspace validation renders modal report', async () => {
  const ui = new TerminalUi({
    api: async (path) => {
      if (path === '/projects/p1/validate') {
        return {
          valid: true,
          actualRemote: null,
          stack: 'Go'
        };
      }
      if (path === '/projects/p1/git/state') {
        return { gitState: 'LOCAL_GIT_NO_REMOTE' };
      }
      return { id: 'p1', slug: 'p1', name: 'Project 1', workspace_path: '/tmp/p1' };
    },
    getActiveProject: () => 'p1',
    setActiveProject: () => {}
  });

  ui.projects = [{ id: 'p1', slug: 'p1', name: 'Project 1' }];
  ui.tabIndex = 0;
  ui.selected = 0;

  await ui.validateWorkspace();
  assert.ok(ui.modal);
  assert.match(ui.modal.title, /Workspace Health: p1/);
  assert.match(ui.modal.lines.join('\n'), /VALID \/ HEALTHY/);
  assert.match(ui.modal.lines.join('\n'), /LOCAL_GIT_NO_REMOTE/);
});

test('TUI unit: pressing c or n in projects tab opens create form modal', () => {
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'p1',
    setActiveProject: () => {}
  });

  ui.projects = [{ id: 'p1', slug: 'p1', name: 'Project 1' }];
  ui.tabIndex = 0;

  ui.handleKey('c', { name: 'c' });
  assert.ok(ui.modal);
  assert.equal(ui.modal.type, 'form');
  assert.match(ui.modal.title, /Create New Project/);
  assert.equal(ui.modal.fields[0].key, 'name');
});

test('TUI unit: pressing g in projects tab opens configure remote form modal', () => {
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'p1',
    setActiveProject: () => {}
  });

  ui.projects = [{ id: 'p1', slug: 'p1', name: 'Project 1' }];
  ui.tabIndex = 0;

  ui.handleKey('g', { name: 'g' });
  assert.ok(ui.modal);
  assert.equal(ui.modal.type, 'form');
  assert.match(ui.modal.title, /Configure Git Remote/);
});

test('TUI unit: wrapText wraps words and long tokens cleanly', () => {
  const wrapped = wrapText('The quick brown fox jumps over the lazy dog', 15);
  for (const line of wrapped) {
    assert.ok(line.length <= 15);
  }
  const longToken = wrapText('https://github.com/lukman-ss/some-extremely-long-repo-name', 20);
  for (const line of longToken) {
    assert.ok(line.length <= 20);
  }
});

test('TUI unit: renderModalScreen ensures lines do not exceed cols', () => {
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'p1',
    setActiveProject: () => {}
  });
  ui.modal = {
    title: 'Submit Task',
    type: 'input',
    subtitle: 'Target: p1',
    label: 'Prompt:'
  };
  ui.inputBuffer = 'Line 1 of prompt\nLine 2 with very long description that needs word wrapping to stay within modal limits';
  const cols = 80;
  const rows = 24;
  const screen = ui.renderModalScreen(cols, rows);
  const lines = screen.split('\n');
  assert.ok(lines.length <= rows);
  for (const line of lines) {
    assert.ok(visibleLen(line) <= cols);
  }
});

test('TUI unit: bracketed paste buffers multi-line text without premature return submit', () => {
  let submitted = null;
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'p1',
    setActiveProject: () => {}
  });

  ui.openPromptModal('Task', { label: 'Enter Prompt:' }, (val) => {
    submitted = val;
  });

  // Paste starts
  ui.handleKey(undefined, { name: 'paste-start' });
  assert.equal(ui.isPasting, true);

  // Paste chunk 1
  ui.handleKey('line 1', { name: 'line 1' });
  // Enter inside pasted text (emits return in readline)
  ui.handleKey('\r', { name: 'return' });
  // Modal must NOT have closed or submitted!
  assert.equal(submitted, null);
  assert.ok(ui.modal);

  // Paste chunk 2
  ui.handleKey('line 2', { name: 'line 2' });

  // Paste ends
  ui.handleKey(undefined, { name: 'paste-end' });
  assert.equal(ui.isPasting, false);
  assert.equal(submitted, null);
  assert.equal(ui.inputBuffer, 'line 1\nline 2');

  // Explicit user Enter triggers submission
  ui.handleKey('\r', { name: 'return' });
  assert.equal(submitted, 'line 1\nline 2');
  assert.equal(ui.modal, null);
});

test('TUI unit: tasks tab status priority ordering and cycling filter', () => {
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'p1',
    setActiveProject: () => {}
  });

  ui.tabIndex = 1; // tasks tab
  ui.tasks = [
    { id: 't-done', status: 'completed', prompt: 'done task', created_at: '2026-11-04 01:00:00' },
    { id: 't-fail', status: 'failed', prompt: 'fail task', created_at: '2026-11-04 02:00:00' },
    { id: 't-run', status: 'running', prompt: 'run task', created_at: '2026-11-04 03:00:00' },
    { id: 't-blok', status: 'blocked', prompt: 'blok task', created_at: '2026-11-04 04:00:00' }
  ];

  // Default ordering: RUNNING (1), BLOCKED (2), COMPLETED (3), FAILED (4)
  const items = ui.getFilteredItems();
  assert.equal(items[0].id, 't-run');
  assert.equal(items[1].id, 't-blok');
  assert.equal(items[2].id, 't-done');
  assert.equal(items[3].id, 't-fail');

  // Key 's' cycles filter: ALL -> RUNNING -> BLOCKED -> COMPLETED -> FAILED
  ui.handleKey('s', { name: 's' });
  assert.equal(ui.taskStatusFilter, 'RUNNING');
  assert.equal(ui.getFilteredItems().length, 1);
  assert.equal(ui.getFilteredItems()[0].id, 't-run');
});

test('TUI unit: pointer in projects defaults to active project and preserves per-tab cursor', async () => {
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'p2',
    setActiveProject: () => {}
  });

  ui.projects = [
    { slug: 'p0', name: 'Project 0' },
    { slug: 'p1', name: 'Project 1' },
    { slug: 'p2', name: 'Project 2' }
  ];
  ui.tasks = [
    { id: 't0', status: 'completed', prompt: 'task 0' },
    { id: 't1', status: 'completed', prompt: 'task 1' }
  ];

  // Projects tab renders body panes: pointer must default to p2 (idx 2)
  ui.renderBodyPanes(60, 60, 20);
  assert.equal(ui.selected, 2);

  // Switch to tasks tab
  await ui.handleKey('', { name: 'tab' });
  assert.equal(ui.tab, 'tasks');
  assert.equal(ui.selected, 0);

  // Move down on tasks
  await ui.handleKey('j', { name: 'down' });
  assert.equal(ui.selected, 1);

  // Switch to approvals, then back to projects
  ui.switchTab(0);
  assert.equal(ui.tab, 'projects');
  assert.equal(ui.selected, 2); // Preserved!

  // Switch back to tasks
  ui.switchTab(1);
  assert.equal(ui.tab, 'tasks');
  assert.equal(ui.selected, 1); // Preserved!
});

test('TUI unit: auto-approval 5-tier policy (OFF|LOW|MEDIUM|HIGH|MAX=NO LIMIT) and key cycling', async () => {
  const decided = [];
  const ui = new TerminalUi({
    api: async (url, opts) => {
      if (url.includes('/decide')) {
        decided.push({ url, body: opts?.body });
        return { success: true };
      }
      return [];
    },
    getActiveProject: () => 'p1',
    setActiveProject: () => {}
  });

  const appLow = {
    id: 'app-low-1',
    project_id: 'p1',
    files_changed: ['src/utils.js'],
    diff_summary: { added: 1, modified: 0, deleted: 0 },
    proposed_commit_message: 'feat: add helper'
  };
  const appEnv = {
    id: 'app-high-env',
    project_id: 'p1',
    files_changed: ['.env'],
    diff_summary: { added: 0, modified: 1, deleted: 0 },
    proposed_commit_message: 'fix: update env'
  };
  const appMed = {
    id: 'app-med-del',
    project_id: 'p1',
    files_changed: ['src/old.js'],
    diff_summary: { added: 0, modified: 0, deleted: 2 },
    proposed_commit_message: 'refactor: delete old files'
  };
  const appHighFiles = {
    id: 'app-high-many-files',
    project_id: 'p1',
    files_changed: Array.from({ length: 18 }, (_, i) => `src/file_${i}.js`),
    diff_summary: { added: 18, modified: 0, deleted: 0 },
    proposed_commit_message: 'feat: massive overhaul'
  };
  const appHighDel = {
    id: 'app-high-many-deletions',
    project_id: 'p1',
    files_changed: ['src/a.js'],
    diff_summary: { added: 0, modified: 0, deleted: 6 },
    proposed_commit_message: 'chore: remove entire module'
  };
  const appBreaking = {
    id: 'app-high-breaking',
    project_id: 'p1',
    files_changed: ['src/api.js'],
    diff_summary: { added: 1, modified: 1, deleted: 0 },
    proposed_commit_message: 'feat: breaking change to public API'
  };

  // Tier 1: OFF
  assert.equal(isEligibleForAutoApprove(appLow, 'OFF'), false);
  assert.equal(isEligibleForAutoApprove(appMed, 'OFF'), false);
  assert.equal(isEligibleForAutoApprove(appHighFiles, 'OFF'), false);

  // Tier 2: LOW (<= 5 files, 0 deletions, no sensitive)
  assert.equal(isEligibleForAutoApprove(appLow, 'LOW'), true);
  assert.equal(isEligibleForAutoApprove(appMed, 'LOW'), false);
  assert.equal(isEligibleForAutoApprove(appHighFiles, 'LOW'), false);
  assert.equal(isEligibleForAutoApprove(appEnv, 'LOW'), false);

  // Tier 3: MEDIUM (<= 15 files, <= 3 deletions, no sensitive)
  assert.equal(isEligibleForAutoApprove(appLow, 'MEDIUM'), true);
  assert.equal(isEligibleForAutoApprove(appMed, 'MEDIUM'), true);
  assert.equal(isEligibleForAutoApprove(appHighFiles, 'MEDIUM'), false);
  assert.equal(isEligibleForAutoApprove(appHighDel, 'MEDIUM'), false);
  assert.equal(isEligibleForAutoApprove(appBreaking, 'MEDIUM'), false);

  // Tier 4: HIGH (allows large files/deletions, but excludes sensitive files & breaking changes)
  assert.equal(isEligibleForAutoApprove(appLow, 'HIGH'), true);
  assert.equal(isEligibleForAutoApprove(appMed, 'HIGH'), true);
  assert.equal(isEligibleForAutoApprove(appHighFiles, 'HIGH'), true);
  assert.equal(isEligibleForAutoApprove(appHighDel, 'HIGH'), true);
  assert.equal(isEligibleForAutoApprove(appEnv, 'HIGH'), false);
  assert.equal(isEligibleForAutoApprove(appBreaking, 'HIGH'), false);

  // Tier 5: MAX / NO LIMIT (unconditional)
  assert.equal(isEligibleForAutoApprove(appLow, 'MAX'), true);
  assert.equal(isEligibleForAutoApprove(appEnv, 'MAX'), true);
  assert.equal(isEligibleForAutoApprove(appBreaking, 'MAX'), true);
  assert.equal(isEligibleForAutoApprove(appBreaking, 'NO LIMIT'), true);

  // Test interactive key cycling: OFF -> LOW -> MEDIUM -> HIGH -> MAX -> OFF
  ui.approvals = [appLow];
  ui.tabIndex = 2; // Approvals tab

  assert.equal(ui.autoApproveLevel, 'OFF');
  assert.equal(ui.autoApprove, false);

  // Cycle to LOW
  await ui.handleKey('a', { name: 'a' });
  assert.equal(ui.autoApproveLevel, 'LOW');
  assert.equal(ui.autoApprove, true);
  assert.equal(decided.length, 1);
  assert.equal(decided[0].url, '/approvals/app-low-1/decide');

  // Cycle to MEDIUM
  await ui.handleKey('a', { name: 'a' });
  assert.equal(ui.autoApproveLevel, 'MEDIUM');

  // Cycle to HIGH
  await ui.handleKey('a', { name: 'a' });
  assert.equal(ui.autoApproveLevel, 'HIGH');

  // Cycle to MAX
  await ui.handleKey('a', { name: 'a' });
  assert.equal(ui.autoApproveLevel, 'MAX');
  assert.match(ui.renderFooter(80), /Auto-Approve \(MAX=NO LIMIT\)/);

  // Cycle back to OFF
  await ui.handleKey('a', { name: 'a' });
  assert.equal(ui.autoApproveLevel, 'OFF');
  assert.equal(ui.autoApprove, false);
});

test('TUI unit: settings tab navigation, rendering, and interactive toggles', async () => {
  const ui = new TerminalUi({
    api: async () => {},
    getActiveProject: () => 'ballo',
    setActiveProject: () => {}
  });

  // Jump to tab 5 via shortcut '5'
  ui.handleKey('5', {});
  assert.equal(ui.tabIndex, 4);
  assert.equal(ui.tab, 'settings');

  // Verify list of settings
  const items = ui.getFilteredItems();
  assert.ok(items.length >= 10);
  assert.equal(items[0].id, 'git_account');
  assert.equal(items[1].id, 'default_model');
  assert.equal(items[2].id, 'fetch_models');
  assert.equal(items[3].id, 'reasoning_effort');
  assert.equal(items[4].id, 'task_timeout');
  assert.equal(items[5].id, 'max_concurrent');
  assert.equal(items[6].id, 'max_repair');
  assert.equal(items[7].id, 'log_level');
  assert.equal(items[8].id, 'auto_approve');

  // Test body rendering
  ui.selected = 8; // auto_approve
  const panes = ui.renderBodyPanes(30, 48, 20);
  assert.ok(panes.leftLines.some(l => l.includes('SETTINGS & PREFERENCES')));
  assert.ok(panes.leftLines.some(l => l.includes('Auto-Approve Policy')));
  assert.ok(panes.rightLines.some(l => l.includes('SETTING: Auto-Approve Policy')));
  assert.ok(panes.rightLines.some(l => l.includes('Available Tiers / Options:')));

  // Test Enter / Space on auto_approve cycles tier
  assert.equal(ui.autoApproveLevel, 'OFF');
  await ui.handleAction();
  assert.equal(ui.autoApproveLevel, 'LOW');
  assert.match(ui.status, /Auto-approve policy set to: LOW/);

  // Test reasoning effort cycle (index 3)
  ui.selected = 3;
  assert.equal(ui.reasoningEffort, 'medium');
  await ui.handleAction();
  assert.equal(ui.reasoningEffort, 'high');
  assert.match(ui.status, /Reasoning effort set to: HIGH/);

  // Test task timeout cycle (index 4)
  ui.selected = 4;
  assert.equal(ui.taskTimeoutSeconds, 3600);
  await ui.handleAction();
  assert.equal(ui.taskTimeoutSeconds, 7200);
  assert.match(ui.status, /Task timeout set to: 2h/);

  // Test max concurrent tasks cycle (index 5)
  ui.selected = 5;
  assert.equal(ui.maxConcurrentTasks, 2);
  await ui.handleAction();
  assert.equal(ui.maxConcurrentTasks, 4);
  assert.match(ui.status, /Max concurrent tasks set to: 4/);

  // Test max repair retries cycle (index 6)
  ui.selected = 6;
  assert.equal(ui.maxRepairAttempts, 2);
  await ui.handleAction();
  assert.equal(ui.maxRepairAttempts, 3);
  assert.match(ui.status, /Max repair retries set to: 3/);

  // Test log level cycle (index 7)
  ui.selected = 7;
  assert.equal(ui.logLevel, 'info');
  await ui.handleAction();
  assert.equal(ui.logLevel, 'debug');
  assert.match(ui.status, /System log level set to: DEBUG/);

  // Test Git Account modal (index 0)
  ui.selected = 0;
  await ui.handleAction();
  assert.ok(ui.modal);
  assert.equal(ui.modal.title, 'Git Account & Authentication');
  assert.ok(ui.modal.lines.some(l => l.includes('Authentication Options')));

  // Test closing modal
  await ui.handleKey('', { name: 'escape' });
  assert.equal(ui.modal, null);

  // Test footer hotkeys in settings tab
  const footer = ui.renderFooter(80);
  assert.match(footer, /Change Value/);
});
