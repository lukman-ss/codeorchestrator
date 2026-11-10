# Operations Guide

Panduan operasional untuk memantau dan mengelola Coding Orchestrator yang berjalan di bawah PM2.

## Service Management (PM2)

```bash
# Cek status proses
pm2 status

# Lihat log real-time
pm2 logs coding-orchestrator -f

# Restart setelah perubahan konfigurasi / env
pm2 restart coding-orchestrator

# Hentikan
pm2 stop coding-orchestrator

# Simpan state agar pulih otomatis saat reboot
pm2 save
```

Selama graceful shutdown, server menyelesaikan atau mematikan child process aktif dalam `TASK_KILL_GRACE_SECONDS`, melakukan WAL checkpoint pada database SQLite, dan menutup koneksi WebSocket.

---

## Log Inspection

### 1. Aplikasi utama

```bash
tail -f logs/application.log
```

Format JSON pino. Untuk human-readable:

```bash
tail -f logs/application.log | npx pino-pretty
```

### 2. Task execution logs

```bash
cat logs/tasks/<TASK_ID>.log
```

---

## SQLite Database Inspection

```bash
sqlite3 data/orchestrator.db ".tables"
```

Query useful:

```sql
-- Queue summary
SELECT status, count(*) FROM tasks GROUP BY status;

-- Running tasks & PIDs
SELECT id, project_id, status, pid, started_at FROM tasks WHERE status = 'running';

-- Recent jobs
SELECT id, status, completion_percent FROM jobs ORDER BY created_at DESC LIMIT 5;

-- Active integration locks
SELECT * FROM integration_locks;
```

---

## Storage & Capacity Maintenance

### Disk free check
```bash
curl -s -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN" http://127.0.0.1:4000/health | jq '{diskFreeMB, diskUsagePercent}'
```

### Clear orphaned integration locks (jika crash)
```bash
sqlite3 data/orchestrator.db "DELETE FROM integration_locks WHERE acquired_at < datetime('now', '-1 hour');"
```

### Force WAL checkpoint
```bash
sqlite3 data/orchestrator.db "PRAGMA wal_checkpoint(TRUNCATE);"
```
