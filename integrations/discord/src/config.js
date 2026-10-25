import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '../../..');

// Load .env if present without crashing
const loadEnv = () => {
  const envPaths = [
    resolve(process.cwd(), '.env'),
    resolve(ROOT_DIR, '.env'),
    resolve(__dirname, '../.env')
  ];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const idx = trimmed.indexOf('=');
          if (idx !== -1) {
            const key = trimmed.substring(0, idx).trim();
            let val = trimmed.substring(idx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (process.env[key] === undefined) {
              process.env[key] = val;
            }
          }
        }
      } catch {}
    }
  }
};

loadEnv();

const parseCsv = (val) => {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
};

const parseJson = (val, fallback = {}) => {
  if (!val) return fallback;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
};

export const config = {
  // Discord Bot
  token: process.env.DISCORD_BOT_TOKEN || '',
  clientId: process.env.DISCORD_CLIENT_ID || process.env.DISCORD_APPLICATION_ID || '',
  guildId: process.env.DISCORD_GUILD_ID || '',

  // Authorization allowlists
  allowedGuildIds: parseCsv(process.env.DISCORD_ALLOWED_GUILD_IDS),
  allowedChannelIds: parseCsv(process.env.DISCORD_ALLOWED_CHANNEL_IDS),
  allowedUserIds: parseCsv(process.env.DISCORD_ALLOWED_USER_IDS),
  allowedRoleIds: parseCsv(process.env.DISCORD_ALLOWED_ROLE_IDS),

  // Project Access Control
  allowedProjects: parseCsv(process.env.DISCORD_ALLOWED_PROJECTS || '*'),
  userProjects: parseJson(process.env.DISCORD_USER_PROJECTS, {}),

  // Admin access for sensitive commands (like cancel)
  adminUserIds: parseCsv(process.env.DISCORD_ADMIN_USER_IDS),
  adminRoleIds: parseCsv(process.env.DISCORD_ADMIN_ROLE_IDS),

  // Orchestrator API
  apiUrl: (process.env.ORCHESTRATOR_API_URL || 'http://127.0.0.1:4000').replace(/\/+$/, ''),
  wsUrl: (process.env.ORCHESTRATOR_WS_URL || 'ws://127.0.0.1:4000/ws').replace(/\/+$/, ''),
  apiToken: process.env.ORCHESTRATOR_API_TOKEN || '',

  // Persistence
  dbPath: process.env.DISCORD_DB_PATH || resolve(__dirname, '../data/bridge.db'),

  // Rate Limiting & Throttling
  progressUpdateIntervalMs: Number(process.env.PROGRESS_UPDATE_INTERVAL_MS || 2000),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 5000),
  maxAttachmentBytes: Number(process.env.MAX_ATTACHMENT_BYTES || 262144), // 256KB default
  apiTimeoutMs: Number(process.env.ORCHESTRATOR_API_TIMEOUT_MS || 10000)
};

export default config;
