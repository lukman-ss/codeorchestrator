import { EventEmitter } from 'node:events';

class EventBus extends EventEmitter {}
export const eventBus = new EventBus();

export const emitWebSocketEvent = (eventType, subtask, payload = {}) => {
  eventBus.emit(eventType, { eventType, subtask, payload, timestamp: new Date().toISOString() });
};

export default { eventBus, emitWebSocketEvent };
