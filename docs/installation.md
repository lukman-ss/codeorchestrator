# Installation Guide

> **Catatan penting**: Panduan ini menggambarkan alur instalasi yang benar-benar terjadi pada user `lukman-ss` dengan path `/home/lukman-ss/coding-orchestrator` dan workspace `/home/lukman-ss/workspace`. Semua command dijalankan sebagai user tersebut, bukan root. Gunakan path absolut sesuai lingkungan Anda.

## System Requirements

- **CPU**: 2+ vCPUs recommended for multi-agent workloads.
- **RAM**: Minimum 4 GB RAM (8+ GB recommended when running concurrent OpenCode subprocesses).
- **Disk**: Minimum 10 GB free disk space. The service automatically blocks task execution when free space falls below `MIN_FREE_DISK_MB` (default 2048 MB) or disk usage exceeds `MAX_DISK_USAGE_PERCENT` (default 90%).
- **OS**: Linux (Debian 13 / Ubuntu 24.04).
- **Go**: Hanya dibutuhkan jika proyek yang dikerjakan oleh agent memerlukan kompilasi Go. Tidak diperlukan untuk CodeOrchestrator itu sendiri.

## 0. Prasyarat Lalu Lengkapi

### Node.js / npm

```bash
node -v    # harus v24.x.x
npm -v     # harus 11.x.x
which node
which npm
```

### Git

```bash
git --version   # harus 2.30+
git config user.name
git config user.email
```

Pastikan Git memiliki akses SSH ke GitHub:

```bash
ssh -T git@github.com
```

### OpenCode CLI

OpenCode adalah engine yang dipanggil oleh CodeOrchestrator untuk menjalankan tugas coding. Jangan bingung: `opencode` adalah upstream CLI, sedangkan `co tui` adalah TUI CodeOrchestrator.

```bash
# Cek apakah sudah terpasang
which opencode || echo "Belum terpasang"
opencode --version
```

### PM2

PM2 digunakan untuk mengelola proses server CodeOrchestrator. Tidak digunakan `systemctl` untuk mengelola aplikasi Node.js.

```bash
which pm2 || echo "Belum terpasang"
pm2 --version
```

## 1. System Packages

On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y curl git build-essential python3
```

## 2. Install Node.js 24

Install Node.js 24 using NodeSource or your preferred version manager:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v # Should output v24.x.x
```

## 3. Install OpenCode

CodeOrchestrator memanggil `opencode` sebagai subprocess. Pasang ke `$HOME/.opencode/bin` agar tidak bentrok dengan binary global lain.

```bash
npm install -g opencode --prefix $HOME/.opencode
# Tambahkan ke PATH
export PATH="$HOME/.opencode/bin:$PATH"
echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> ~/.bashrc
# Verifikasi
which opencode
opencode --version
```

**Perbedaan penting**:
- `opencode` → membuka OpenCode CLI secara langsung
- `co tui` → membuka terminal dashboard CodeOrchestrator

## 4. Repository Setup

### 4a. Periksa direktori sebelum clone

Jika direktori tujuan sudah ada (misalnya dari setup sebelumnya), clone akan gagal dengan `destination exists`.

```bash
# Periksa apakah direktori sudah ada
ls -d /home/lukman-ss/coding-orchestrator 2>/dev/null && echo "Direktori sudah ada" || echo "Aman untuk clone"

# Jika ingin mempertahankan:
cd /home/lukman-ss/coding-orchestrator
git status
git pull

# Jika ingin memindahkan sisa:
mv /home/lukman-ss/coding-orchestrator /home/lukman-ss/coding-orchestrator.old
```

**Jangan hapus direktori tanpa pemeriksaan terlebih dahulu.**

### 4b. Clone

```bash
cd /home/lukman-ss
git clone git@github.com:lukman-ss/codeorchestrator.git coding-orchestrator
cd coding-orchestrator
```

### 4c. Install dependencies

```bash
npm ci
```

`package-lock.json` sudah memiliki `resolved` URL untuk semua dependency, termasuk `better-sqlite3`. Tidak perlu `npm install-scripts approve` atau `npm rebuild` pada sistem standar.

Jika munculkan warning lockfile tanpa `resolved` URL, perbarui lockfile:

```bash
npm install --package-lock-only
```

## 5. Directory Structure & Permissions

The orchestrator creates workspace directories and databases at runtime:

```bash
# Ensure runtime data and logs directories are writable
mkdir -p data logs workspace .agent-worktrees
```

Review [Configuration](configuration.md), [Deployment](deployment.md), and [Operations](operations.md) for service setup.
