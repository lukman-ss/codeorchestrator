#!/usr/bin/env bash
set -euo pipefail

# Public Release Validation Gate for Coding Orchestrator
# Pre-release verification checking security, tests, and documentation integrity.
# Returns 0 only when all release criteria are met.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "===================================================="
echo "Coding Orchestrator — Public Release Gate"
echo "===================================================="

# Step 1: Run Security & Confidentiality Audit
echo ""
echo "[Step 1/3] Running security and confidentiality audit..."
"$ROOT_DIR/scripts/security-check.sh"

# Step 2: Run Automated Test Suite
echo ""
echo "[Step 2/3] Running automated unit and integration tests..."
npm test

# Step 3: Verify Documentation and Markdown Links
echo ""
echo "[Step 3/3] Validating documentation links and integrity..."
node -e "
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

let errors = 0;
const checkDoc = (filePath) => {
  const content = readFileSync(filePath, 'utf8');
  // Match relative markdown links [text](path)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const target = match[2].split('#')[0]; // strip anchor
    if (!target || target.startsWith('http://') || target.startsWith('https://') || target.startsWith('mailto:') || target.startsWith('#')) {
      continue;
    }
    const resolved = resolve(dirname(filePath), target);
    if (!existsSync(resolved)) {
      console.error('[-] Dead link in ' + filePath + ': ' + match[2] + ' -> ' + resolved);
      errors++;
    }
  }
};

if (existsSync('README.md')) checkDoc('README.md');
if (existsSync('CONTRIBUTING.md')) checkDoc('CONTRIBUTING.md');
if (existsSync('SECURITY.md')) checkDoc('SECURITY.md');
if (existsSync('docs')) {
  for (const f of readdirSync('docs')) {
    if (f.endsWith('.md')) checkDoc(join('docs', f));
  }
}

if (errors > 0) {
  console.error('[-] Documentation validation failed with ' + errors + ' broken link(s).');
  process.exit(1);
} else {
  console.log('[+] All documentation links resolved successfully.');
}
"

echo ""
echo "===================================================="
echo "[+] SUCCESS: All public release validation gates passed."
echo "===================================================="
exit 0
