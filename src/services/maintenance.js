import { dbGet, dbRun, dbPrepare } from '../database/db.js';
import { TASK_EVENT_RETENTION_DAYS, CLEANUP_INTERVAL_HOURS } from '../config.js';
import logger from '../logger.js';

const msPerHour = 3600 * 1000;

export const cleanupTaskEvents = () => {
  const cutoff = new Date(Date.now() - TASK_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // Delete events for tasks that are finished and older than cutoff
  const stmt = dbPrepare(`DELETE FROM task_events WHERE task_id IN (
    SELECT id FROM tasks WHERE status IN ('completed','failed','cancelled','interrupted') AND finished_at < ?
  )`);
  const info = stmt.run(cutoff);
  logger.info({ affectedRows: info.changes, event: 'task_events_cleanup' }, 'Cleaned up old task events');
};

export const scheduleCleanup = () => {
  setInterval(() => {
    try {
      cleanupTaskEvents();
    } catch (err) {
      logger.error({ err, event: 'cleanup_error' }, 'Error during task events cleanup');
    }
  }, CLEANUP_INTERVAL_HOURS * msPerHour);
};
