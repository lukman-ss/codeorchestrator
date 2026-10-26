import WebSocket from 'ws';
import config from './config.js';
import {
  formatJobCard,
  formatTaskCard,
  safeMentions,
  safeMessageEdit,
  safeChannelSend
} from './notifications.js';

export class OrchestratorEventListener {
  constructor(apiClient, persistence, discordClient, cfg = config) {
    this.apiClient = apiClient;
    this.persistence = persistence;
    this.discordClient = discordClient;
    this.config = cfg;

    this.ws = null;
    this.isConnected = false;
    this.isStopping = false;

    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;

    this.pollTimer = null;
    this.processedEvents = new Set();
    this.maxProcessedCache = 5000;

    // Per-execution message update throttling
    this.pendingUpdates = new Map(); // id -> { timeout, payload, lastSent }
  }

  start() {
    this.isStopping = false;
    this.connectWs();
    this.startPollingFallback();
  }

  stop() {
    this.isStopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Flush any pending updates
    for (const [id, item] of this.pendingUpdates.entries()) {
      if (item.timeout) clearTimeout(item.timeout);
    }
    this.pendingUpdates.clear();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.isConnected = false;
  }

  connectWs() {
    if (this.isStopping) return;

    try {
      const headers = {};
      const protocols = [];
      if (this.config.apiToken) {
        headers['Authorization'] = `Bearer ${this.config.apiToken}`;
        protocols.push(this.config.apiToken);
      }

      this.ws = new WebSocket(this.config.wsUrl, protocols.length > 0 ? protocols : undefined, {
        headers
      });

      this.ws.on('open', () => {
        this.isConnected = true;
        this.reconnectDelay = 1000; // Reset backoff
        // Subscribe to all realtime events
        try {
          this.ws.send(JSON.stringify({ type: 'subscribe', all: true }));
        } catch {}
      });

      this.ws.on('message', (data) => {
        try {
          const ev = JSON.parse(data.toString());
          this.handleEvent(ev);
        } catch {}
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        this.scheduleReconnect();
      });

      this.ws.on('error', () => {
        this.isConnected = false;
        try {
          this.ws.close();
        } catch {}
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.isStopping || this.reconnectTimer) return;
    const currentDelay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, currentDelay);
  }

  startPollingFallback() {
    this.pollActiveExecutions().catch(() => {});
    this.pollTimer = setInterval(async () => {
      if (this.isStopping) return;
      // If WS is down, poll all active executions
      // Even if WS is up, bounded poll guarantees recovery from missed network packets
      await this.pollActiveExecutions();
    }, this.config.pollIntervalMs);
  }

  async pollActiveExecutions() {
    const active = this.persistence.getActiveExecutions();
    for (const exec of active) {
      try {
        if (exec.kind === 'task') {
          const task = await this.apiClient.getTask(exec.id);
          if (task && task.status !== exec.status) {
            this.persistence.updateExecution(exec.id, { status: task.status });
            this.scheduleDiscordMessageUpdate(exec.id, 'task', task);
          }
        } else if (exec.kind === 'job') {
          const job = await this.apiClient.getJob(exec.id);
          if (job && (job.status !== exec.status || job.verified_requirements !== exec.last_event_sequence)) {
            this.persistence.updateExecution(exec.id, {
              status: job.status,
              lastEventSequence: job.verified_requirements
            });
            this.scheduleDiscordMessageUpdate(exec.id, 'job', job);
          }
        }
      } catch {}
    }
  }

  isDuplicate(eventKey) {
    if (this.processedEvents.has(eventKey)) return true;
    if (this.processedEvents.size >= this.maxProcessedCache) {
      const first = this.processedEvents.values().next().value;
      this.processedEvents.delete(first);
    }
    this.processedEvents.add(eventKey);
    return false;
  }

  async handleEvent(ev) {
    if (!ev || !ev.type) return;

    const eventType = ev.type || ev.eventType;
    const taskId = ev.taskId || (ev.subtask && !ev.subtask.job_id ? ev.subtask.id : null);
    const jobId = ev.jobId || ev.subtask?.job_id || ev.payload?.job_id || ev.data?.job_id;

    const id = jobId || taskId || ev.id;
    if (!id) return;

    // Deduplication check
    const dedupKey = `${eventType}:${id}:${ev.sequence ?? ev.timestamp ?? JSON.stringify(ev.payload || ev.data || '')}`;
    if (this.isDuplicate(dedupKey)) {
      return;
    }

    const exec = this.persistence.getExecution(id);
    if (!exec) return; // Not an execution tracked by this Discord bot

    // Multi-Agent Job Events
    if (exec.kind === 'job') {
      let latestEventText = null;
      let newStatus = exec.status;

      if (eventType === 'job.created') {
        newStatus = 'planning';
        latestEventText = 'Job requirements extracted';
      } else if (eventType === 'agent.started') {
        newStatus = 'running';
        latestEventText = `Agent started: ${ev.payload?.role || 'worker'}`;
      } else if (eventType === 'audit.started') {
        newStatus = 'auditing';
        latestEventText = 'Acceptance criteria verification started';
      } else if (eventType === 'audit.passed') {
        latestEventText = 'Audit PASSED for subtask';
      } else if (eventType === 'audit.failed') {
        latestEventText = 'Audit FAILED for subtask';
      } else if (eventType === 'repair.started') {
        newStatus = 'repairing';
        latestEventText = 'Repair engineer spawned';
      } else if (eventType === 'integration.started') {
        latestEventText = 'Workspace integration started';
      } else if (eventType === 'integration.passed') {
        latestEventText = 'Integration checks PASSED';
      } else if (eventType === 'job.completed') {
        newStatus = 'completed';
        latestEventText = 'All requirements satisfied';
      } else if (eventType === 'job.partially_completed') {
        newStatus = 'partially_completed';
        latestEventText = 'Job completed with partial requirements';
      } else if (eventType === 'job.cancelled') {
        newStatus = 'cancelled';
        latestEventText = 'Job cancelled';
      } else if (eventType === 'job.blocked') {
        newStatus = 'blocked';
        latestEventText = 'Job blocked by dependency or retries';
      }

      this.persistence.updateExecution(id, {
        status: newStatus,
        lastEventSequence: ev.sequence ?? exec.last_event_sequence,
        lastEventId: dedupKey
      });

      // Fetch fresh job details and schedule update
      try {
        const job = await this.apiClient.getJob(id);
        const agents = await this.apiClient.getJobAgents(id).catch(() => null);
        this.scheduleDiscordMessageUpdate(id, 'job', job, { latestEvent: latestEventText, agents });
      } catch {
        this.scheduleDiscordMessageUpdate(id, 'job', { ...exec, status: newStatus }, { latestEvent: latestEventText });
      }
    }

    // Simple Task Events
    if (exec.kind === 'task') {
      let latestEventText = null;
      let newStatus = exec.status;

      if (eventType === 'task.queued') {
        newStatus = 'queued';
      } else if (eventType === 'task.started') {
        newStatus = 'running';
        latestEventText = 'Process spawned';
      } else if (eventType === 'task.progress') {
        latestEventText = ev.data?.step || 'Running';
      } else if (eventType === 'task.tool') {
        latestEventText = `Running tool ${ev.data?.tool || 'unknown'}`;
      } else if (eventType === 'task.completed') {
        newStatus = 'completed';
        latestEventText = 'Task finished successfully';
      } else if (eventType === 'task.failed') {
        newStatus = 'failed';
        latestEventText = `Task failed: ${ev.data?.error || 'non-zero exit'}`;
      } else if (eventType === 'task.cancelled') {
        newStatus = 'cancelled';
        latestEventText = 'Task cancelled';
      }

      this.persistence.updateExecution(id, {
        status: newStatus,
        lastEventSequence: ev.sequence ?? exec.last_event_sequence,
        lastEventId: dedupKey
      });

      try {
        const task = await this.apiClient.getTask(id);
        this.scheduleDiscordMessageUpdate(id, 'task', task, { latestEvent: latestEventText });
      } catch {
        this.scheduleDiscordMessageUpdate(id, 'task', { ...exec, status: newStatus }, { latestEvent: latestEventText });
      }
    }
  }

  scheduleDiscordMessageUpdate(id, kind, entity, extra = {}) {
    const exec = this.persistence.getExecution(id);
    if (!exec || !exec.channel_id || !exec.message_id) return;

    const isTerminal = ['completed', 'failed', 'cancelled', 'partially_completed', 'interrupted'].includes(
      entity.status || exec.status
    );

    const now = Date.now();
    const existing = this.pendingUpdates.get(id);

    // Build formatted message content
    const content =
      kind === 'job'
        ? formatJobCard(entity, { projectSlug: exec.project_slug, ...extra })
        : formatTaskCard(entity, { projectSlug: exec.project_slug, ...extra });

    if (isTerminal) {
      if (existing?.timeout) clearTimeout(existing.timeout);
      this.pendingUpdates.delete(id);
      this.executeMessageEdit(id, exec, content, isTerminal);
      return;
    }

    if (existing) {
      existing.content = content;
      // If there isn't a timer already scheduled, schedule one for remaining interval
      if (!existing.timeout) {
        const timeSinceLast = now - existing.lastSent;
        const delay = Math.max(0, this.config.progressUpdateIntervalMs - timeSinceLast);
        existing.timeout = setTimeout(() => {
          const item = this.pendingUpdates.get(id);
          if (item) {
            this.executeMessageEdit(id, exec, item.content, false);
            item.lastSent = Date.now();
            item.timeout = null;
          }
        }, delay);
      }
      return;
    }

    // First time seeing this update: execute immediately and record lastSent
    this.executeMessageEdit(id, exec, content, false);
    this.pendingUpdates.set(id, { timeout: null, content, isTerminal: false, lastSent: now });
  }

  async executeMessageEdit(id, exec, content, isTerminal) {
    if (!this.discordClient || !this.discordClient.channels) return;

    try {
      const channel = await this.discordClient.channels.fetch(exec.channel_id).catch(() => null);
      if (!channel) return;

      const message = await channel.messages.fetch(exec.message_id).catch(() => null);
      if (message) {
        await safeMessageEdit(message, {
          content,
          allowedMentions: safeMentions
        }, { type: 'progress_card' });
      } else if (isTerminal) {
        // If original message is missing and terminal, send new message to notify
        await safeChannelSend(channel, {
          content,
          allowedMentions: safeMentions
        }, { type: 'progress_card' });
      }

      // If terminal, send final completion notification if requested
      if (isTerminal) {
        const terminalStatus = (exec.status || '').toUpperCase();
        const notification = `Execution \`${id}\` reached terminal state: **${terminalStatus}**`;
        await safeChannelSend(channel, {
          content: notification,
          allowedMentions: safeMentions
        }, { type: 'terminal_notification' }).catch(() => {});
      }
    } catch {}
  }
}

export default OrchestratorEventListener;
