import { WebSocketServer } from 'ws';
import { getBuffer, onEvent, offEvent, getDispatchQueue } from '../services/task-queue.js';
import { getTaskEvents } from '../services/task-service.js';
import { eventBus } from './event-bus.js';
import { API_AUTH_TOKEN, CANCEL_TIMEOUT_MS } from '../config.js';
import logger from '../logger.js';

export const setupWebSocket = (server) => {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info, cb) => {
      const authHeader = info.req.headers['authorization'];
      const protocols = (info.req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
      if (!API_AUTH_TOKEN) {
        cb(false, 401, 'Unauthorized'); return;
      }
      const valid = authHeader === `Bearer ${API_AUTH_TOKEN}` || protocols.includes(API_AUTH_TOKEN);
      if (!valid) cb(false, 401, 'Unauthorized'); else cb(true);
    }
  });

  const clientMap = new Map(); // ws -> { taskId, jobId, subscribeAll, listener, busListener, pingInterval }

  wss.on('connection', (ws, req) => {
    let taskId = null;
    let jobId = null;
    let subscribeAll = false;
    let listener = null;
    let busListener = null;
    let isAlive = true;

    ws.on('pong', () => { isAlive = true; });

    const pingInterval = setInterval(() => {
      if (!isAlive) {
        clearInterval(pingInterval);
        return ws.terminate();
      }
      isAlive = false;
      ws.ping();
    }, 30000);

    const cleanupListeners = () => {
      if (listener && taskId) {
        offEvent(taskId, listener);
        listener = null;
      }
      if (busListener) {
        eventBus.off('*', busListener);
        busListener = null;
      }
    };

    clientMap.set(ws, { taskId, jobId, subscribeAll, listener, busListener, pingInterval });

    ws.on('message', (msg) => {
      try {
        const payload = JSON.parse(msg.toString());
        if (payload.type === 'subscribe') {
          cleanupListeners();
          taskId = payload.taskId || null;
          jobId = payload.jobId || null;
          subscribeAll = payload.all === true || (!taskId && !jobId);

          if (taskId) {
            const afterSeq = Number(payload.afterSequence) || 0;
            let events = [];
            try {
              events = getTaskEvents(taskId, afterSeq);
            } catch {
              events = getBuffer(taskId).filter(e => e.sequence > afterSeq);
            }

            if (afterSeq > 0 && events.length > 0) {
              const allAvailable = getTaskEvents(taskId, 0);
              const lowestAvailable = allAvailable.length > 0 ? allAvailable[0].sequence : 1;
              if (lowestAvailable > afterSeq + 1) {
                ws.send(JSON.stringify({
                  type: 'task.replay_gap',
                  taskId,
                  requestedAfterSequence: afterSeq,
                  oldestAvailableSequence: lowestAvailable,
                  timestamp: new Date().toISOString()
                }));
              }
            }

            for (const ev of events) {
              const out = ev.payload_json ? {
                type: ev.type,
                taskId: ev.task_id,
                sequence: ev.sequence,
                timestamp: ev.created_at,
                data: JSON.parse(ev.payload_json)
              } : ev;
              ws.send(JSON.stringify(out));
            }

            listener = (ev) => {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
            };
            onEvent(taskId, listener);
          }

          busListener = (ev) => {
            if (ws.readyState !== ws.OPEN) return;
            if (subscribeAll) {
              ws.send(JSON.stringify(ev));
              return;
            }
            if (jobId) {
              const match = ev.jobId === jobId ||
                ev.subtask?.job_id === jobId ||
                ev.payload?.job_id === jobId ||
                ev.data?.job_id === jobId;
              if (match) ws.send(JSON.stringify(ev));
              return;
            }
            if (taskId) {
              const match = ev.taskId === taskId ||
                ev.subtask?.id === taskId ||
                ev.payload?.taskId === taskId ||
                ev.data?.taskId === taskId;
              // note: if already dispatched by task emitter, avoid duplicate if sent by emitter
              if (match && !listener) ws.send(JSON.stringify(ev));
            }
          };
          eventBus.on('*', busListener);

          clientMap.set(ws, { taskId, jobId, subscribeAll, listener, busListener, pingInterval });
        } else if (payload.type === 'unsubscribe') {
          cleanupListeners();
          taskId = null;
          jobId = null;
          subscribeAll = false;
          clientMap.set(ws, { taskId, jobId, subscribeAll, listener: null, busListener: null, pingInterval });
        }
      } catch (err) {
        logger.warn({ err, event: 'ws_bad_message' }, 'WebSocket invalid message');
      }
    });

    ws.on('close', (code, reason) => {
      clearInterval(pingInterval);
      cleanupListeners();
      clientMap.delete(ws);
      logger.trace({ taskId, code, reason: reason.toString() }, 'WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      clearInterval(pingInterval);
      cleanupListeners();
      clientMap.delete(ws);
      logger.warn({ err, event: 'ws_error' }, 'WebSocket client error');
    });
  });

  wss.on('close', () => {
    for (const [ws, { taskId, listener, busListener, pingInterval }] of clientMap) {
      clearInterval(pingInterval);
      if (listener && taskId) offEvent(taskId, listener);
      if (busListener) eventBus.off('*', busListener);
    }
    clientMap.clear();
  });

  return wss;
};

export const shutdownWebSocket = (wss, timeoutMs = 5000) => {
  logger.info({ event: 'ws_shutdown', timeoutMs }, 'Shutting down WebSocket server');
  const closed = new Set();
  const remaining = new Set();
  const deadline = Date.now() + timeoutMs;

  for (const [ws, { taskId, listener, pingInterval }] of wss.clients) {
    clearInterval(pingInterval);
    if (listener && taskId) {
      offEvent(taskId, listener);
      try {
        ws.send(JSON.stringify({
          type: 'orchestrator.shutting_down',
          timestamp: new Date().toISOString()
        }));
      } catch {}
    }
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.info({ event: 'ws_shutdown_timeout', remaining: wss.clients.size }, 'WebSocket shutdown timeout reached');
      resolve();
    }, timeoutMs);

    wss.close((err) => {
      clearTimeout(timer);
      if (err) logger.error({ err, event: 'ws_close_error' }, 'WebSocket close error');
      resolve();
    });
  });
};

export const getWebSocketStats = (wss) => {
  if (!wss) return { clients: 0, subscriptions: new Set() };
  let subscriptions = new Set();
  for (const [ws, { taskId }] of wss.clients) {
    if (taskId) subscriptions.add(taskId);
  }
  return { clients: wss.clients.size, subscriptions };
};

export default { setupWebSocket, shutdownWebSocket, getWebSocketStats };