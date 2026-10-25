import { ParallelScheduler } from '../services/parallel-scheduler.js';
import { dbGet } from '../database/db.js';

export const getAgentCapacity = (jobId) => {
  return {
    globalRunning: ParallelScheduler.getGlobalRunning(),
    maxGlobal: ParallelScheduler.MAX_GLOBAL_AGENT_PROCESSES,
    byRole: ParallelScheduler.getRunningByRole(),
    limits: {
      maxWorkers: ParallelScheduler.MAX_PARALLEL_WORKERS,
      maxAuditors: ParallelScheduler.MAX_PARALLEL_AUDITORS,
      maxIntegrations: ParallelScheduler.MAX_PARALLEL_INTEGRATIONS
    }
  };
};
