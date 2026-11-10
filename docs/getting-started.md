# Getting Started

Panduan ini menjelaskan cara memasang, konfigurasi, dan menjalankan tugas coding pertama dengan Coding Orchestrator.

## Prerequisites

- **OS**: Linux (Debian 13 / Ubuntu 24.04).
- **Node.js**: v24.x (`node -v`).
- **npm**: v11.x (`npm -v`).
- **Git**: 2.30+ dengan `user.name` dan `user.email` terkonfigurasi.
- **OpenCode CLI**: Terpasang di `$HOME/.opencode/bin/opencode`.
- **PM2**: Terpasang di `$HOME/.local/npm/bin/pm2`.

> **Penting**: `opencode` adalah engine upstream yang dipanggil oleh CodeOrchestrator. `co tui` adalah TUI dashboard CodeOrchestrator — bukan OpenCode langsung. Jangan tertukar.

## Quick Start

### 1. Clone & Install Dependencies

```bash
cd /home/lukman-ss
git clone git@github.com:lukman-ss/codeorchestrator.git coding-orchestrator
cd coding-orchestrator
npm ci
```

`package-lock.json` sudah memiliki `resolved` URL untuk semua dependency termasuk `better-sqlite3`. Tidak perlu `npm rebuild` pada sistem standar.

### 2. Konfigurasi Environment

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env` dan ganti semua placeholder `/path/to/...` dengan path absolut Anda:

```ini
# Replace placeholder paths with actual values
ORCHESTRATOR_ROOT=/home/lukman-ss/coding-orchestrator
WORKSPACE_ROOT=/home/lukman-ss/workspace
DATABASE_PATH=/home/lukman-ss/coding-orchestrator/data/orchestrator.db
AGENT_WORKTREE_ROOT=/home/lukman-ss/workspace/.agent-worktrees
OPENCODE_BIN=/home/lukman-ss/.opencode/bin/opencode

# Fill in secrets
ORCHESTRATOR_API_TOKEN=<generate-secure-random-token>
NINEROUTER_API_KEY=<your-9router-api-key>
```

**Verifikasi tidak ada placeholder yang tertinggal:**
```bash
grep -n '/path/to' .env
# Tidak ada output = aman
```

> `ORCHESTRATOR_API_TOKEN` dan `NINEROUTER_API_KEY` adalah secret yang berbeda. Jangan pernah mencetak nilainya di dokumentasi atau log.

### 3. Jalankan Server dengan PM2

```bash
export PATH="$HOME/.local/npm/bin:$HOME/.opencode/bin:$PATH"
cd /home/lukman-ss/coding-orchestrator
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs coding-orchestrator --lines 20
```

Server mulai. Health check:
```bash
curl -s -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN" http://127.0.0.1:4000/health
```

> **Catatan**: `npm start` menjalankan `node src/server.js` **tanpa** memuat `.env`. Gunakan PM2 atau `node --env-file=.env src/server.js` agar `.env` terbaca. Tanpa `.env`, server akan exit dengan error `missing_auth_token`.

### 4. Pasang CLI & Buka TUI

```bash
# Pasang binary co secara global untuk user
npm install --global --prefix $HOME/.local/npm /home/lukman-ss/coding-orchestrator

# Verifikasi
command -v co
command -v opencode
command -v pm2

# Buka TUI CodeOrchestrator (server harus sudah online)
co tui
```

`co tui` menampilkan dashboard terminal CodeOrchestrator dengan panel proyek, task, dan approval.

### 5. Daftarkan Proyek (Opsional)

Jika sudah ada repository yang di-clone ke workspace, daftarkan ke database:

```bash
# Contoh: import proyek yang sudah di-clone
co project import /home/lukman-ss/workspace/my-project
```

`GET /projects` akan mengembalikan daftar proyek setelah import.

### 6. Tes Task Pertama

```bash
co task create my-project "Tambahkan fitur X ke file Y"
```

---

## Next Steps

- [API Reference](api-reference.md) — endpoint REST lengkap
- [Task Lifecycle](task-lifecycle.md) — alur task dari submit sampai completion
- [Operations](operations.md) — prosedur operasional harian
- [Troubleshooting](troubleshooting.md) — diagnosis masalah umum
