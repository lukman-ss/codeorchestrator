# CodeOrchestrator — Discord Bot Integration Guide

This guide details setup, configuration, security model, and deployment for the CodeOrchestrator Discord Bridge service.

---

## 1. Overview & Architecture

The Discord Bridge is an isolated gateway service running alongside CodeOrchestrator:

```
[ Discord Client / Guild ]
           │
           │ (Slash commands & Autocomplete)
           ▼
[ Discord Bridge Service ]
   ├── Authentication & Allowlist Gate
   ├── REST Client ──────► [ CodeOrchestrator REST API ]
   │                       (POST /projects/:id/tasks, POST /jobs, cancel, etc.)
   ├── Realtime WS ◄────── [ CodeOrchestrator WebSocket Plane ]
   │                       (task.*, job.*, agent.*, audit.*, integration.*)
   └── Persistence Store ─► [ SQLite bridge.db ]
```

### Architectural Invariants

- **No Direct OpenCode Execution**: The Discord Bridge never spawns `opencode` processes directly.
- **Queue Preservation**: All tasks and multi-agent jobs are submitted through CodeOrchestrator's API and adhere to scheduling limits.
- **No Orchestrator DB Mutation**: The Bridge does not write into `orchestrator.db`; it stores Discord interaction mappings in a dedicated `bridge.db`.
- **Hermes Isolation**: Hermes remains an independent service. Its bot tokens and configuration are never reused or modified.
- **Strict Authentication**: Every request to the orchestrator uses `Authorization: Bearer <ORCHESTRATOR_API_TOKEN>`.

---

## 2. Discord Developer Portal Setup

### 2.1 Create Discord Application

1. Navigate to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and name it `CodeOrchestrator`.
3. In the **General Information** tab, copy the **Application ID** (`DISCORD_CLIENT_ID`).

### 2.2 Create Bot User

1. Navigate to the **Bot** tab.
2. Click **Add Bot** / **Reset Token** to generate a bot token (`DISCORD_BOT_TOKEN`).
3. Under **Privileged Gateway Intents**:
   - `Message Content Intent`: Not strictly required (slash commands and attachments are used).
   - `Server Members Intent`: Optional (enables member role caching).

### 2.3 Required Discord Permissions

When inviting the bot, request the following permissions:
- `Send Messages` (`0x800`)
- `View Channels` (`0x400`)
- `Attach Files` (`0x8000`)
- `Read Message History` (`0x10000`)
- `Use Application Commands` (`0x80000000`)

Permission integer: `2147551232`.

### 2.4 OAuth2 Bot Installation URL

Generate an invite URL via **OAuth2 → URL Generator**:
- Scopes: `bot`, `applications.commands`
- Bot Permissions: `Send Messages`, `View Channels`, `Attach Files`, `Read Message History`

Example URL template:
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=2147551232
```

---

## 2.5 Channel Discovery & Routing Model

Similar to Hermes, CodeOrchestrator discovers Discord channels automatically directly from incoming interactions (`interaction.channelId`):
- **Automatic Channel Discovery**: No manual channel registration or static `DISCORD_ALLOWED_CHANNEL_IDS` list is required. The bot dynamically accepts commands in any channel where the bot has appropriate Discord permissions and the requesting user is authorized.
- **Public & Private Channels**: Both public and private channels are supported without differentiating them via hardcoded IDs. Access to private channels is governed natively by Discord channel permissions. If the bot is invited to a private channel or granted `ViewChannel` + `SendMessages` permissions, it functions immediately without configuration changes or bot restarts.
- **Originating-Channel Response Routing**: When a task or job is submitted, the originating channel ID is persisted alongside the execution record. All real-time progress cards, notifications, and terminal completion notices route exclusively to the originating channel.
- **Optional Channel Allowlist**: `DISCORD_ALLOWED_CHANNEL_IDS` is completely optional. If left empty or unset, all bot-accessible channels in authorized guilds are permitted. If explicitly populated with snowflake IDs, it serves as an extra restriction layer.

---

## 3. Configuration Variables

Configure these settings in the private `.env` file:

| Variable | Type | Default | Description |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | String | _None_ | Bot authentication token from Developer Portal |
| `DISCORD_CLIENT_ID` | String | _None_ | Application ID for registering slash commands |
| `DISCORD_GUILD_ID` | String | _Empty_ | Guild ID for instant guild-scoped slash command registration |
| `DISCORD_ALLOWED_GUILD_IDS` | CSV | _Empty_ | Allowed Discord server IDs (default: DENY) |
| `DISCORD_ALLOWED_CHANNEL_IDS`| CSV | _Empty_ | Optional allowed Discord channel IDs (default: auto-discovery in bot-accessible channels) |
| `DISCORD_ALLOWED_USER_IDS` | CSV | _Empty_ | Allowed Discord user IDs (`*` or list of snowflake IDs) |
| `DISCORD_ALLOWED_ROLE_IDS` | CSV | _Empty_ | Allowed Discord role IDs for authorization |
| `DISCORD_ALLOWED_PROJECTS` | CSV | `*` | Project IDs/slugs accessible across the bot |
| `DISCORD_USER_PROJECTS` | JSON | `{}` | Per-user project authorization map: `{"user_id": ["proj1"]}` |
| `DISCORD_ADMIN_USER_IDS` | CSV | _Empty_ | User IDs authorized to execute sensitive commands like `/code cancel` |
| `DISCORD_ADMIN_ROLE_IDS` | CSV | _Empty_ | Role IDs authorized for administrative actions |
| `ORCHESTRATOR_API_URL` | URL | `http://127.0.0.1:4000` | CodeOrchestrator REST endpoint |
| `ORCHESTRATOR_WS_URL` | URL | `ws://127.0.0.1:4000/ws` | CodeOrchestrator WebSocket endpoint |
| `ORCHESTRATOR_API_TOKEN` | String | _Empty_ | Bearer token for orchestrator API authentication |
| `DISCORD_DB_PATH` | Path | `.../data/bridge.db` | Dedicated SQLite database for interaction persistence |
| `PROGRESS_UPDATE_INTERVAL_MS`| Integer | `2000` | Rate-limit throttling window for message updates (ms) |
| `POLL_INTERVAL_MS` | Integer | `5000` | Fallback REST polling interval when WS is disconnected |
| `MAX_ATTACHMENT_BYTES` | Integer | `262144` | Maximum prompt attachment size (256 KB) |

---

## 4. Slash Commands (`/code`)

All actions run under the `/code` command group:

### `/code projects`
Lists available projects authorized for the requesting user.
- Displays: Name, ID, slug, and configured default model.

### `/code run project:<name> prompt:<text>`
Submits a simple coding task to the execution queue.
- Resolves project name/slug with autocomplete.
- Returns initial queued progress card with task ID.

### `/code job project:<name> [prompt:<text>] [attachment:<file>]`
Submits a multi-agent workflow decomposed into requirements.
- Supports `.txt` and `.md` UTF-8 specification files up to 256 KB.
- Returns initial progress card with job ID and requirement count.

### `/code status id:<id>`
Retrieves real-time status of a task or job.
- Displays active worker/auditor counts, verification progress, and latest event.

### `/code audit id:<id>`
Fetches independent auditor results for a subtask or job.
- Displays verdict (`PASS` / `FAILED`), failed criteria, and evidence.
- Never turns unverified findings into PASS.

### `/code report id:<id>`
Retrieves final execution report.
- Large reports exceeding Discord message limits (2000 chars) are attached as a sanitized `.txt` file.

### `/code cancel id:<id> [confirm:True]`
Cancels an active task or job.
- Requires explicit confirmation via parameter `confirm:True` or interactive button.
- Enforces administrative permissions.

### `/code help`
Displays command usage and syntax examples.

---

## 5. Security Architecture

1. **Default Deny**: Commands originating from unlisted guilds, channels, or users are rejected with `Access Denied`.
2. **DM Execution Disabled**: Slash commands explicitly set `dmPermission: false` and reject DM interaction payloads.
3. **Secret Redaction**: All outbound Discord messages pass through `redactSensitive()`:
   - API tokens (`NINEROUTER_API_KEY`, `ORCHESTRATOR_API_TOKEN`, `sk-...`, `ghp_...`, JWTs)
   - Discord bot tokens
   - Private SSH/cryptographic keys (`-----BEGIN PRIVATE KEY-----`)
   - Internal Tailscale CGNAT and RFC1918 private IP address ranges
   - Host user deployment home directories (`/home/<user>`)
4. **Mentions Suppression**: All message sends and edits pass `allowedMentions: { parse: [] }` to prevent ping injection (`@everyone`, `@here`).
5. **Attachment Sanitization**: Non-text extensions and files with binary null bytes are rejected.

---

## 6. Interaction Lifecycle & Progress Persistence

Discord interaction tokens expire after 15 minutes. Long-running jobs run significantly longer:

1. On submission (`/code run` or `/code job`), the bot calls `await interaction.deferReply()`.
2. Initial status card is posted via `editReply()`.
3. The bridge stores a record in SQLite `bridge.db`:
   - `id`: Task or Job ID
   - `guild_id`, `channel_id`, `user_id`
   - `message_id`: ID of the initial bot message
4. Subscribed WebSocket events update the persistent progress message via `channel.messages.edit(message_id)`.
5. Message edits are throttled to at most once every 2 seconds (`PROGRESS_UPDATE_INTERVAL_MS`).
6. Terminal states (`completed`, `failed`, `cancelled`) flush immediately and issue a completion notification.
7. If the service restarts, `getActiveExecutions()` resumes tracking for unfinished jobs.

---

## 7. Systemd Deployment

### 7.1 Service Unit File

Create `/etc/systemd/system/codeorchestrator-discord.service`:

```ini
[Unit]
Description=CodeOrchestrator Discord Bridge Service
Documentation=https://github.com/anomalyco/opencode
After=network.target
Wants=network.target

[Service]
Type=simple
User=%USER%
Group=%GROUP%
WorkingDirectory=/path/to/coding-orchestrator/integrations/discord
EnvironmentFile=/path/to/coding-orchestrator/.env
ExecStart=/usr/bin/node /path/to/coding-orchestrator/integrations/discord/src/index.js
Restart=on-failure
RestartSec=10
TimeoutStopSec=15
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/path/to/coding-orchestrator/integrations/discord/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### 7.2 Service Management Commands

```bash
# Reload systemd manager configuration
sudo systemctl daemon-reload

# Enable service to start on system boot
sudo systemctl enable codeorchestrator-discord.service

# Start the service
sudo systemctl start codeorchestrator-discord.service

# Inspect service status
sudo systemctl status codeorchestrator-discord.service

# View live service logs
journalctl -u codeorchestrator-discord.service -f
```

---

## 8. Local Development & Testing

```bash
# Run unit and integration tests
npm test

# Run Discord bridge tests directly
cd integrations/discord && npm test

# Start Discord Bridge in local development mode
cd integrations/discord && npm start
```

---

## 9. Troubleshooting

| Symptom | Cause | Solution |
|---|---|---|
| `Access Denied: This server is not authorized` | Guild not in allowlist | Add Guild ID to `DISCORD_ALLOWED_GUILD_IDS` in `.env` |
| `Access Denied: Commands cannot be executed in this channel` | Optional `DISCORD_ALLOWED_CHANNEL_IDS` is configured and excludes this channel | Add Channel ID to `DISCORD_ALLOWED_CHANNEL_IDS` or clear the variable for auto-discovery |
| `Access Denied: Bot lacks required channel permissions` | Bot lacks `ViewChannel` or `SendMessages` in this channel | Update channel permissions in Discord to grant the bot access |
| `Access Denied: You are not authorized` | User ID or role not in allowlist | Add User ID to `DISCORD_ALLOWED_USER_IDS` or role to `DISCORD_ALLOWED_ROLE_IDS` |
| Slash commands do not appear in Discord | Global commands take up to 1 hr to sync | Set `DISCORD_GUILD_ID` in `.env` for instant guild-level command registration |
| `Failed to download prompt attachment` | Attachment expired or network failure | Re-submit prompt or paste specification as text prompt |
| WebSocket reconnecting repeatedly | Orchestrator not running or token mismatch | Check `ORCHESTRATOR_API_TOKEN` matches in both orchestrator and bridge `.env` |

---

## 10. Known Limitations

- **Discord Message Limit**: Discord messages are capped at 2000 characters. Large logs and execution reports are automatically attached as text files.
- **Single Process Lock**: A PID lock prevents multiple bridge processes from running concurrently and competing for message edits.

---

## 11. Audit Kerahasiaan & Kredensial (Confidentiality & Credential Audit)

Audit komprehensif terhadap penanganan kerahasiaan data dan kredensial pada pembaruan integrasi Discord Bridge:

### 11.1 Inventarisasi Kredensial & Batasan Rahasia
- **`DISCORD_BOT_TOKEN`**: Token bot Discord dengan hak akses gateway. Disimpan secara eksklusif pada runtime environment (`.env` atau systemd `EnvironmentFile` berizin `0600`), tidak pernah di-hardcode ke repositori atau terekspos ke log/message payload.
- **`ORCHESTRATOR_API_TOKEN`**: Bearer token bersama untuk autentikasi REST dan WebSocket API CodeOrchestrator. Dilindungi dengan perbandingan waktu konstan (`crypto.timingSafeEqual`) pada orchestrator.
- **`NINEROUTER_API_KEY`**: Kunci LLM gateway yang hanya diteruskan orchestrator ke subproses OpenCode. Komponen Discord Bridge tidak pernah mengakses, menyimpan, atau mengekspos token ini.
- **Hermes Credentials**: Layanan Hermes beroperasi terpisah secara independen. Tidak ada token, bot session, atau konfigurasi Hermes yang disentuh, diubah, atau digunakan kembali oleh Discord Bridge.

### 11.2 Kontrol Akses & Batasan Otorisasi
- **Default-Deny Access Policy**: Permintaan dari guild, user, atau role yang tidak tercantum dalam konfigurasi allowlist (`DISCORD_ALLOWED_GUILD_IDS`, `DISCORD_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_ROLE_IDS`) langsung ditolak dengan status *Access Denied*. Konfigurasi channel (`DISCORD_ALLOWED_CHANNEL_IDS`) bersifat opsional; jika kosong, kanal diizinkan berdasarkan hak akses native Discord bot (`ViewChannel`, `SendMessages`) dan otorisasi pengguna.
- **DM Execution Disabled**: Interaksi Direct Message diblokir total (`dmPermission: false` dan pengecekan interaksi) guna mencegah eksfiltrasi di luar saluran resmi.
- **Isolasi Saluran Asal (Originating Channel Isolation)**: Notifikasi progres dan pembaruan hasil selalu diarahkan kembali secara eksklusif ke channel asal eksekusi (`channel_id`), mencegah kebocoran informasi antar kanal.
- **Isolasi Proyek (RBAC Granular)**: Akses proyek dibatasi melalui `DISCORD_ALLOWED_PROJECTS` dan mapping spesifik per-user `DISCORD_USER_PROJECTS`. Pengguna tidak dapat menjalankan tugas pada proyek di luar izin.
- **Perintah Administratif Sensitif**: Perintah pembatalan (`/code cancel`) mewajibkan otorisasi administrator (`DISCORD_ADMIN_USER_IDS` atau `DISCORD_ADMIN_ROLE_IDS`) dan konfirmasi eksplisit.

### 11.3 Sanitasi Data Keluar & Pencegahan Kebocoran (Data Redaction)
Setiap transmisi data keluar ke Discord (embed status, pesan teks, dan file laporan) diproses melalui filter `redactSensitive()`:
- **Token & Kunci Rahasia**: Menyaring format token API (`sk-...`, `ghp_...`, `xox...`, JWT, token Discord bot, token orchestrator).
- **Kunci Kriptografi Privat**: Menyaring blok kunci privat SSH dan TLS (`-----BEGIN ... PRIVATE KEY-----`).
- **Infrastruktur Jaringan Internal**: Menyaring alamat IP privat RFC1918 (blok 10.x, 192.168.x) dan rentang CGNAT / Tailscale (100.64.x s/d 100.127.x).
- **Path Deployment Host**: Menyaring path direktori lokal mesin (`/home/<user>`) menjadi `[REDACTED_PATH]`.
- **Pencegahan Mention Injection**: Semua pesan dikirim dengan `allowedMentions: { parse: [] }` untuk mencegah eksploitasi ping `@everyone` atau `@here`.
- **Sanitasi File Attachment**: File prompt dibatasi hanya untuk format teks UTF-8 (`.txt`, `.md`), ukuran maksimal 256 KB, dan langsung ditolak jika mengandung null byte (`\0`).

### 11.4 Integritas & Kerahasiaan Penyimpanan (Persistence)
- **Isolasi SQLite Bridge**: Database `integrations/discord/data/bridge.db` hanya menyimpan metadata pelacakan eksekusi (`id`, `guild_id`, `channel_id`, `user_id`, `message_id`, timestamps).
- **Zero Content Storage**: Isi prompt lengkap, diff kode, log sensitif, dan rahasia tidak disimpan di dalam `bridge.db`.
- **Zero Direct Orchestrator DB Mutation**: Discord Bridge tidak memiliki akses langsung maupun hak tulis ke database inti `orchestrator.db`.

### 11.5 Keamanan Sistem Operasi & Deployment
- Unit systemd `codeorchestrator-discord.service` dijalankan dengan user unprivileged non-root.
- Sandboxing proses Linux aktif: `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=read-only`, dan `PrivateTmp=true`.
- Akses baca-tulis dibatasi ketat hanya pada direktori `integrations/discord/data`.
- Template konfigurasi `.env.example` bersih dari rahasia riil dan hanya memuat placeholder aman.

### 11.6 Hasil Verifikasi Gate Otomatis
- `scripts/security-check.sh`: **PASSED** (0 pelanggaran keamanan, 0 peringatan kebocoran rahasia atau path lokal).
- `scripts/public-release-check.sh`: **PASSED** (audit keamanan, validasi integritas dokumentasi, dan seluruh test suite lulus).
