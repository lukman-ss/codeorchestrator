import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DATABASE_PATH, WORKSPACE_ROOT } from '../src/config.js';

export function inspectAndCleanTestData({ dbPath = DATABASE_PATH, workspaceRoot = WORKSPACE_ROOT, apply = false } = {}) {
  if (!existsSync(dbPath)) throw new Error(`DB not found at: ${dbPath}`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const allProjects = db.prepare('SELECT * FROM projects').all();
  const testProjects = [];
  const userProjects = [];

  // Reliable test classification based on timestamped test runner slug patterns
  const testPatterns = [
    /^smoke-test-/,
    /^smoke-\d+/,
    /^cancel-test-/,
    /^cancel-\d+/,
    /^conflict-test-/,
    /^crash-test-/,
    /^crash-recovery-/,
    /^dependency-test-/,
    /^parallel-test-/,
    /^acceptance-\d+/,
    /^concurrency-\d+/,
    /^audit-test-/,
    /^existing-proj-\d+/,
    /^e2e-multi-agent-/,
    /^opencode-test$/,
    /^orchestrator-smoke-test$/,
    /^p0-test-proj$/,
    /^test-prompt$/
  ];

  for (const p of allProjects) {
    const isMarked = p.is_test === 1;
    const matchesPattern = testPatterns.some(rx => rx.test(p.slug));
    if (isMarked || matchesPattern) {
      testProjects.push(p);
    } else {
      userProjects.push(p);
    }
  }

  const breakdown = {};
  for (const p of testProjects) {
    let category = 'other-test';
    if (/^smoke/.test(p.slug)) category = 'smoke-test';
    else if (/^cancel/.test(p.slug)) category = 'cancel-test';
    else if (/^conflict/.test(p.slug)) category = 'conflict-test';
    else if (/^crash/.test(p.slug)) category = 'crash-test';
    else if (/^dependency/.test(p.slug)) category = 'dependency-test';
    else if (/^parallel/.test(p.slug)) category = 'parallel-test';
    else if (/^acceptance/.test(p.slug)) category = 'acceptance-test';
    else if (/^concurrency/.test(p.slug)) category = 'concurrency-test';
    else if (/^audit-test/.test(p.slug)) category = 'audit-test';
    else if (/^existing-proj/.test(p.slug)) category = 'existing-proj-test';
    else if (/^e2e/.test(p.slug)) category = 'e2e-test';
    else if (/^(opencode-test|orchestrator-smoke-test|p0-test-proj|test-prompt)$/.test(p.slug)) category = 'manual-test';

    breakdown[category] = (breakdown[category] || 0) + 1;
  }

  console.log('====================================================');
  console.log('CodeOrchestrator Test Data Audit & Cleanup Procedure');
  console.log('====================================================');
  console.log(`Mode: ${apply ? 'APPLY (Mutations Enabled)' : 'DRY RUN (Read Only)'}`);
  console.log(`Database: ${dbPath}`);
  console.log(`Workspace: ${workspaceRoot}`);
  console.log(`Total Projects in DB: ${allProjects.length}`);
  console.log(`Identified Test Projects: ${testProjects.length}`);
  console.log(`Identified Legitimate User Projects: ${userProjects.length}`);
  console.log('\nTest Data Breakdown:');
  for (const [k, v] of Object.entries(breakdown)) {
    console.log(`  - ${k}: ${v}`);
  }

  if (userProjects.length > 0) {
    console.log('\nPreserved User Projects:');
    for (const p of userProjects) {
      console.log(`  - ID: ${p.id} | Slug: ${p.slug} | Name: ${p.name}`);
    }
  }

  // Check which workspaces exist on disk
  const workspacesFound = [];
  for (const p of testProjects) {
    const ws = p.workspace_path || join(workspaceRoot, p.slug);
    if (existsSync(ws)) workspacesFound.push(ws);
  }
  console.log(`\nTest Workspace Directories Found On Disk: ${workspacesFound.length}`);

  if (!apply) {
    console.log('\n[Dry-Run Notice] No changes applied. To apply cleanup after operator approval, run:');
    console.log('  node scripts/cleanup-test-data.js --apply');
  } else {
    console.log('\nApplying cleanup...');
    // We mark is_test = 1 rather than hard deleting to preserve historical records safely,
    // or if full purge requested:
    db.transaction(() => {
      for (const p of testProjects) {
        db.prepare('UPDATE projects SET is_test = 1 WHERE id = ?').run(p.id);
      }
    })();
    console.log(`[Apply] Successfully marked ${testProjects.length} projects as is_test=1 for clean Discord/API listing.`);
  }

  db.close();
  return { allCount: allProjects.length, testCount: testProjects.length, userCount: userProjects.length, breakdown };
}

if (process.argv[1] && process.argv[1].endsWith('cleanup-test-data.js')) {
  const isApply = process.argv.includes('--apply');
  inspectAndCleanTestData({ apply: isApply });
}
