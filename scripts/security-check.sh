#!/usr/bin/env bash
set -euo pipefail

# Security Audit and Credential Gate for Coding Orchestrator
# Scans staged, tracked, and repository source files for secrets and exposure.
# Never prints actual secret values.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ERRORS=0
WARNINGS=0

echo "===================================================="
echo "Coding Orchestrator — Security & Confidentiality Gate"
echo "===================================================="

# Helper for reporting findings safely without printing secret values
report_violation() {
  local rule="$1"
  local file="$2"
  local line="${3:-N/A}"
  echo "[-] VIOLATION: $rule in $file (line $line)"
  ERRORS=$((ERRORS + 1))
}

report_warning() {
  local rule="$1"
  local file="$2"
  local line="${3:-N/A}"
  echo "[!] WARNING: $rule in $file (line $line)"
  WARNINGS=$((WARNINGS + 1))
}

# 1. Check for Forbidden Untracked / Staged / Tracked Sensitive Files
echo "[*] Checking for forbidden file patterns in repository..."
FORBIDDEN_FILES_REGEX='(^|/)(\.env|\.env\.[^.]*|.*\.db|.*\.db-(wal|shm)|.*\.sqlite[0-9]?|.*\.log|.*\.log\.gz|id_rsa|id_ed25519|.*\.pem|.*\.key)$'

# Check Git tracking / staging if git repo
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # Tracked files
  while IFS= read -r file; do
    if [[ -n "$file" && "$file" != ".env.example" && "$file" =~ $FORBIDDEN_FILES_REGEX ]]; then
      report_violation "Forbidden file is tracked by git" "$file"
    fi
  done < <(git ls-files)

  # Staged files
  while IFS= read -r file; do
    if [[ -n "$file" && "$file" != ".env.example" && "$file" =~ $FORBIDDEN_FILES_REGEX ]]; then
      report_violation "Forbidden file is staged for commit" "$file"
    fi
  done < <(git diff --name-only --cached)
fi

# 2. Check for Private Keys in repository source tree
echo "[*] Scanning for private cryptographic keys..."
while IFS= read -r match; do
  if [[ -n "$match" ]]; then
    file=$(echo "$match" | cut -d: -f1)
    line=$(echo "$match" | cut -d: -f2)
    report_violation "Private cryptographic key pattern detected" "$file" "$line"
  fi
done < <(grep -rnE --exclude-dir={node_modules,.git,data,logs,workspaces} 'BEGIN (RSA|OPENSSH|EC|DSA|PGP)? PRIVATE KEY' . 2>/dev/null || true)

# 3. Check for High-Entropy Secret Patterns and API Keys
echo "[*] Scanning for exposed API tokens and hardcoded credentials..."
PATTERNS=(
  'NINEROUTER_API_KEY=[a-zA-Z0-9_-]{12,}'
  'ORCHESTRATOR_API_TOKEN=[a-zA-Z0-9_-]{12,}'
  'ghp_[a-zA-Z0-9]{36}'
  'github_pat_[a-zA-Z0-9_]{50,}'
  'sk-[a-zA-Z0-9]{20,}'
  'xox[baprs]-[0-9a-zA-Z]{10,48}'
  'ey[A-Za-z0-9_-]{15,}\.ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}'
)

for pat in "${PATTERNS[@]}"; do
  while IFS= read -r match; do
    if [[ -n "$match" ]]; then
      file=$(echo "$match" | cut -d: -f1)
      line=$(echo "$match" | cut -d: -f2)
      # Skip tests/fixtures if synthetic
      if [[ "$file" =~ tests/fixtures/.* ]]; then
        continue
      fi
      # Disallow test-token-123 in src or configs
      if [[ "$file" =~ ^(\./)?src/ || "$file" =~ ^(\./)?\.env\.example$ ]]; then
        report_violation "Exposed secret pattern [$pat]" "$file" "$line"
      fi
    fi
  done < <(grep -rnE --exclude-dir={node_modules,.git,data,logs,workspaces,coverage} "$pat" . 2>/dev/null || true)
done

# 4. Check for Internal Infrastructure Disclosure (Tailscale / RFC1918 IPs)
echo "[*] Scanning for internal infrastructure IP disclosure..."
IP_REGEX='(100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})'
while IFS= read -r match; do
  if [[ -n "$match" ]]; then
    file=$(echo "$match" | cut -d: -f1)
    line=$(echo "$match" | cut -d: -f2)
    # Ignore fixtures, node_modules, and documentation generic mentions
    if [[ "$file" =~ tests/fixtures/.* || "$file" =~ ^(\./)?docs/security\.md ]]; then
      continue
    fi
    report_violation "Private/Tailscale IP address detected" "$file" "$line"
  fi
done < <(grep -rnE --exclude-dir={node_modules,.git,data,logs,workspaces} "$IP_REGEX" . 2>/dev/null || true)

# 5. Check for Deployment-Specific User Path Leakage (/home/<user>)
echo "[*] Scanning for local user path leakage (/home/lukman-ss)..."
LOCAL_USER="lukman-ss"
while IFS= read -r match; do
  if [[ -n "$match" ]]; then
    file=$(echo "$match" | cut -d: -f1)
    line=$(echo "$match" | cut -d: -f2)
    if [[ "$file" =~ tests/fixtures/.* || "$file" =~ ^(\./)?scripts/security-check\.sh$ ]]; then
      continue
    fi
    report_violation "Specific home directory path (/home/$LOCAL_USER) detected" "$file" "$line"
  fi
done < <(grep -rnE --exclude-dir={node_modules,.git,data,logs,workspaces} "/home/$LOCAL_USER" . 2>/dev/null || true)

# 6. Check Git History If Available
echo "[*] Checking Git history for sensitive commits..."
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git rev-parse --verify HEAD >/dev/null 2>&1; then
  COMMITS_COUNT=$(git rev-list --count HEAD)
  echo "[+] Git history contains $COMMITS_COUNT commits. Scanning commit diffs..."
  while IFS= read -r commit_match; do
    if [[ -n "$commit_match" ]]; then
      commit_hash=$(echo "$commit_match" | cut -d: -f1)
      report_violation "Historical commit contains secret pattern" "$commit_hash"
    fi
  done < <(git log -p | grep -nE 'NINEROUTER_API_KEY=[a-zA-Z0-9_-]{12,}' || true)
else
  echo "[i] Git repository has 0 commits. No historical commits to audit."
fi

# 7. Check .env.example for live secrets
echo "[*] Auditing .env.example..."
if [[ -f ".env.example" ]]; then
  if grep -E '=(sk-|ghp_|9router-|[a-f0-9]{32})' .env.example >/dev/null 2>&1; then
    report_violation "Active secret value detected in .env.example" ".env.example"
  fi
else
  report_violation "Missing .env.example configuration template" ".env.example"
fi

echo "===================================================="
echo "Security Audit Summary:"
echo "Violations: $ERRORS"
echo "Warnings:   $WARNINGS"
echo "===================================================="

if [[ $ERRORS -gt 0 ]]; then
  echo "[-] FAILED: Security checks detected $ERRORS blocking violation(s)."
  exit 1
fi

echo "[+] PASSED: All security and confidentiality checks completed cleanly."
exit 0
