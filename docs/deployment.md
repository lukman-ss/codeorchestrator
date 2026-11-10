# Deployment Guide

Panduan ini menjelaskan cara menjalankan Coding Orchestrator secara produksi menggunakan **PM2** sebagai process manager. Tidak menggunakan `systemctl` untuk mengelola proses aplikasi.

## 1. PM2 Setup

PM2 dipasang untuk user (bukan root) di `$HOME/.local/npm`:

```bash
# Verifikasi PM2 tersedia
which pm2 || echo "Belum terpasang"
pm2 --version
```

Jika belum terpasang:

```bash
npm install -g pm2 --prefix $HOME/.local/npm
export PATH="$HOME/.local/npm/bin:$PATH"
echo 'export PATH="$HOME/.local/npm/bin:$PATH"' >> ~/.bashrc
```

---

## 2. Ecosystem Config

Buat atau perbarui `ecosystem.config.cjs` di root repo:

```js
module.exports = {
  apps: [{
    name: "coding-orchestrator",
    cwd: "/home/lukman-ss/coding-orchestrator",
    script: "src/server.js",
    node_args: "--env-file=/home/lukman-ss/coding-orchestrator/.env",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false
  }]
};
```

Catatan penting:
- `node_args` memuat `--env-file` sehingga `.env` dibaca oleh Node saat boot.
- `npm start` **tidak** memuat `.env` secara otomatis; hanya `node --env-file=.env src/server.js` atau PM2 yang memuatnya.
- Jalankan PM2 dari repo agar `cwd` benar.

---

## 3. Start & Manage

```bash
cd /home/lukman-ss/coding-orchestrator

# Start server
pm2 start ecosystem.config.cjs

# Cek status
pm2 status

# Lihat log
pm2 logs coding-orchestrator --lines 50

# Restart setelah perubahan konfigurasi
pm2 restart coding-orchestrator

# Hentikan
pm2 stop coding-orchestrator

# Hapus dari daftar PM2 (tanpa menghentikan proses lain)
pm2 delete coding-orchestrator

# Simpan state untuk pemulihan
pm2 save
```

`pm2 save` menulis state ke `~/.pm2/dump.pm2`.

---

## 4. Pemulihan Setelah Reboot

Gunakan cron `@reboot` untuk memulihkan PM2 setelah reboot:

```bash
# Buat entry cron untuk user lukman-ss
(crontab -l 2>/dev/null; echo "@reboot /home/lukman-ss/.local/npm/bin/pm2 resurrect") | crontab -

# Verifikasi entry ada
crontab -l | grep pm2
```

Entry harus dijalankan sebagai user pemilik proses (`lukman-ss`), bukan root. PM2 `resurrect` membaca `~/.pm2/dump.pm2` dan mengembalikan semua proses yang tersimpan.

**Verifikasi setelah reboot:**
```bash
# Tunggu beberapa detik lalu:
pm2 status
# Harap melihat coding-orchestrator online

# Cek health endpoint
curl -s -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN" http://127.0.0.1:4000/health
```

---

## 5. Environment Security

- Simpan semua secret di `.env` di dalam direktori aplikasi.
- Batasi permission:
  ```bash
  chmod 600 .env
  ```
- Jangan pernah commit `.env` ke Git (sudah diabaikan oleh `.gitignore`).
- `ORCHESTRATOR_API_TOKEN` berbeda dari `NINEROUTER_API_KEY` — jangan tertukar.

---

## 6. Reverse Proxy & TLS

Orchestrator default listen di `127.0.0.1:4000`. **Jangan bind ke `0.0.0.0`** tanpa TLS.

Untuk akses remote, gunakan Caddy atau Nginx:

```caddy
orchestrator.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

Caddy otomatis menangani WebSocket upgrade dan Let's Encrypt TLS.

---

## 7. Backup & Disaster Recovery

### Yang perlu di-backup:
1. `data/orchestrator.db` (SQLite database)
2. `.env` (konfigurasi & secret)
3. `~/workspace/` (kanonik workspace proyek)

### Backup SQLite aman (WAL mode):
```bash
sqlite3 data/orchestrator.db ".backup 'data/backup-$(date +%Y%m%d).db'"
```

Jangan salin file `.db` mentah saat server sedang menulis.
