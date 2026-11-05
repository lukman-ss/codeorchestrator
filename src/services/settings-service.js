// ponytail: stdlib SQLite key-value settings store; upgrade to hierarchical config schema if typed migrations needed.
import { dbGet, dbGetOne, dbRun } from '../database/db.js';

let tableEnsured = false;
function ensureTable() {
  if (tableEnsured) return;
  try {
    dbRun(`CREATE TABLE IF NOT EXISTS orchestrator_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    tableEnsured = true;
  } catch {}
}

export class SettingsService {
  static get(key, defaultValue = null) {
    ensureTable();
    try {
      const row = dbGetOne('SELECT value FROM orchestrator_settings WHERE key = ?', [key]);
      return row ? row.value : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  static getAll() {
    ensureTable();
    try {
      const rows = dbGet('SELECT key, value FROM orchestrator_settings') || [];
      const settings = {};
      for (const r of rows) {
        settings[r.key] = r.value;
      }
      return settings;
    } catch {
      return {};
    }
  }

  static set(key, value) {
    if (!key) return null;
    ensureTable();
    const strVal = String(value);
    dbRun(
      `INSERT INTO orchestrator_settings (key, value, updated_at) 
       VALUES (?, ?, datetime('now')) 
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, strVal]
    );
    return strVal;
  }

  static setMultiple(obj) {
    if (!obj || typeof obj !== 'object') return {};
    ensureTable();
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined && v !== null) {
        this.set(k, v);
      }
    }
    return this.getAll();
  }
}
