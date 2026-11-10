# Troubleshooting Guide

Panduan diagnostik untuk masalah umum saat menjalankan Coding Orchestrator.

## Common Issues & Diagnoses

### 1. Service Fails to Start: Missing Auth Token

**Symptoms**: Server exit dengan kode 1. Log menampilkan:
`{"level":60,"event":"missing_auth_token","msg":"ORCHESTRATOR_API_TOKEN must be set when REQUIRE_AUTH is true"}`

**Cause**: `REQUIRE_AUTH=true` (default), tetapi `ORCHESTRATOR_API_TOKEN` kosong atau tidak ter-load dari `.env`.

**Resolution**:
```ini
# Di .env
REQUIRE_AUTH=false              # opsi: matikan auth (hanya local/dev)
ORCHESTRATOR_API_TOKEN=<random-secure-token>  # opsi: isi token
```

Verifikasi environment terbaca oleh PM2:
```bash
pm2 show coding-orchestrator | grep env-file
pm2 logs coding-orchestrator --lines 30
```

---

### 2. `co`, `opencode`, atau `pm2`: command not found

**Symptoms**:
```
bash: co: command not found
bash: opencode: command not found
bash: pm2: command not found
```

**Cause**: PATH belum termuat di sesi shell saat ini atau login berikutnya.

**Resolution**:
```bash
# Tambahkan ke ~/.bashrc
echo 'export PATH="$HOME/.local/npm/bin:$HOME/.opencode/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Verifikasi
command -v co && command -v opencode && command -v pm2
```

---

### 3. Placeholder `/path/to/...` Tertinggal di `.env`

**Symptoms**: Server error path tidak valid, `ENOENT` pada open/readdir.

**Cause**: `.env.example` belum diubah setelah copy ke `.env`.

**Resolution**:
```bash
grep -n '/path/to' .env
# Ganti semua baris yang masih berisi placeholder
sed -i 's|/path/to/coding-orchestrator|$HOME/coding-orchestrator|g' .env
sed -i 's|/path/to/workspace|$HOME/workspace|g' .env
```

---

### 4. `.env` Tidak Termuat Saat Menjalankan Secara Manual

**Symptoms**: `npm start` gagal dengan `missing_auth_token`.

**Cause**: `npm start` menjalankan `node src/server.js` tanpa flag `--env-file`.

**Resolution**:
```bash
# Cara benar secara manual
node --env-file=.env src/server.js

# Atau gunakan PM2 (disarankan)
pm2 start ecosystem.config.cjs
```

---

### 5. `better-sqlite3` Build Gagal

**Symptoms**: `npm ci` atau `npm install` berhenti dengan error compilation native addon.

**Cause**: Toolchain build missing atau lockfile kurang `resolved` URL.

**Resolution**:
```bash
sudo apt install -y build-essential python3
npm ci
# Jika masih gagal (jarang):
npm rebuild better-sqlite3
```

---

### 6. Port Server Bentrok (EADDRINUSE)

**Symptoms**: Server gagal bind port 4000.

**Cause**: Proses lain sudah menggunakan port.

**Resolution**:
```bash
lsof -i :4000
# Matikan proses yang bersaing
kill -9 <PID>
# Atau ubah PORT di .env
```

---

### 7. Model/Provider Error: Unexpected Server Error

**Symptoms**: Task gagal dengan error model atau provider gateway 4xx/5xx.

**Cause**:
- `NINEROUTER_API_KEY` salah/tidak ada
- Suffix model seperti `#medium` tidak didukung upstream → error
- Nama model salah

**Resolution**:
```bash
# Test model langsung via OpenCode
opencode run -m 9router/ayce-combo "ping"

# Pastikan DEFAULT_MODEL sesuai — hindari suffix seperti #medium
# DEFAULT_MODEL=9router/ayce-combo
```

---

### 8. Workspace Kosong / Belum Terdaftar

**Symptoms**: `GET /projects` mengembalikan `[]`, padahal repo sudah ada di filesystem.

**Cause**: Direktori workspace belum didaftarkan ke database CodeOrchestrator.

**Resolution**:
```bash
# Import direktori workspace yang sudah ada
co project import /home/lukman-ss/workspace/nama-repo

# Atau via REST
curl -X POST http://127.0.0.1:4000/projects/import \
  -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"directory": "/home/lukman-ss/workspace/nama-repo", "name": "nama-repo"}'
```

---

### 9. PM2 Tidak Memulihkan Proses Setelah Reboot

**Symptoms**: Setelah reboot, server tidak berjalan.

**Cause**: Entry cron `@reboot pm2 resurrect` tidak terpasang atau salah user.

**Resolution**:
```bash
# Verifikasi entry cron
crontab -l | grep pm2

# Jika belum ada, tambahkan (sebagai user lukman-ss):
(crontab -l 2>/dev/null; echo "@reboot /home/lukman-ss/.local/npm/bin/pm2 resurrect") | crontab -

# Cek PM2 dump tersimpan
pm2 dump
```

---

### 10. HTTP 401 Unauthorized

**Symptoms**: Semua request API kena 401.

**Cause**: Header `Authorization: Bearer <token>` tidak cocok dengan nilai `ORCHESTRATOR_API_TOKEN` di `.env`.

**Resolution**:
```bash
# Cek token yang aktif
grep ORCHESTRATOR_API_TOKEN .env | cut -d= -f2- | head -c 8
# Gunakan token yang sama di header Authorization
curl -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:4000/health
```

---

## Quick Diagnostic Checklist

```bash
# Environment loaded correctly?
pm2 describe coding-orchestrator | grep -i env-file

# Binary locations valid?
ls -la $(which co) $(which opencode) $(which pm2)

# Server responding?
curl -s -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN" http://127.0.0.1:4000/health | jq .status

# PM2 process online?
pm2 status | grep coding-orchestrator

# Cron reboot recovery present?
crontab -l | grep pm2
```
