import { EventEmitter } from 'node:events';

class EventBus extends EventEmitter {}
export const eventBus = new EventBus();

export const emitWebSocketEvent = (eventType, subtask, payload = {}) => {
  const eventObj = {
    type: eventType,
    eventType,
    subtask,
    payload,
    timestamp: new Date().toISOString()
  };
  eventBus.emit(eventType, eventObj);
  eventBus.emit('*', eventObj);
};

export default { eventBus, emitWebSocketEvent };
