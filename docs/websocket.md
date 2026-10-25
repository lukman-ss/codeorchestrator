# WebSocket Realtime Event Plane

The WebSocket interface provides streaming execution telemetry, tool call observations, progress tracking, and event replay for Coding Orchestrator tasks and multi-agent jobs.

## Connection & Handshake

- **Endpoint**: `ws://HOST:PORT/ws` (or `wss://...` when behind a TLS reverse proxy).
- **Authentication**: Authentication is enforced during handshake via either:
  1. Header `Authorization: Bearer <ORCHESTRATOR_API_TOKEN>`
  2. WebSocket subprotocol: `Sec-WebSocket-Protocol: <ORCHESTRATOR_API_TOKEN>`

Connections without valid credentials receive an HTTP `401 Unauthorized` handshake response.

## Connection Heartbeat

The server issues a ping frame every 30 seconds (`30000ms`). Clients must respond with standard RFC 6455 pong frames. If a client fails to respond before the next ping interval, the connection is terminated.

## Protocol Messages

### 1. Subscribe to Task Events

```json
{
  "type": "subscribe",
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "afterSequence": 0
}
```

- `afterSequence` (integer, optional): When greater than 0, replays historical events matching `sequence > afterSequence` before transitioning to live streaming.

### 2. Unsubscribe

```json
{
  "type": "unsubscribe"
}
```

Disconnects the socket from task broadcasts without dropping the WebSocket connection.

---

## Event Format

All emitted events follow a structured JSON schema:

```json
{
  "type": "task.started",
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "sequence": 1,
  "timestamp": "2026-10-25T04:15:00.000Z",
  "data": {
    "pid": 42010,
    "model": "9router/ayce-combo"
  }
}
```

### Event Types

| Event Type | Source | Description |
|---|---|---|
| `task.queued` | Task Queue | Task placed into the execution queue. |
| `task.started` | Task Queue | OpenCode process spawned and execution initiated. |
| `task.progress` | OpenCode | Incremental progress or execution tokens reported by OpenCode. |
| `task.tool` | OpenCode | Tool call observed (e.g. bash execution, file read, write). |
| `task.log` | Task Logger | Log chunk emitted to task stdout/stderr. |
| `task.completed` | Task Queue | Process exited with return code 0. |
| `task.failed` | Task Queue | Process exited with non-zero code or encountered an execution fault. |
| `task.cancelled` | Task Queue | Task explicitly cancelled via API. |
| `task.interrupted` | Recovery | Task process terminated due to orchestrator shutdown or restart. |
| `task.replay_gap` | WebSocket Server | Emitted when requested sequence number has already been pruned from memory/DB. |

### Multi-Agent Event Types

| Event Type | Description |
|---|---|
| `job.created` | New multi-agent job decomposed into requirements. |
| `agent.started` | Agent execution (worker, auditor, repair, integration) started. |
| `agent.progress` | Agent tool invocation or intermediate step completed. |
| `agent.completed` | Agent execution completed successfully. |
| `agent.failed` | Agent execution failed or encountered unhandled error. |
| `audit.started` | Independent acceptance criteria verification began. |
| `audit.passed` | Auditor confirmed all criteria satisfied (`PASS`). |
| `audit.failed` | Auditor rejected implementation (`FAILED`). |
| `integration.started`| Integration lock acquired; merge and tests initiated. |
| `integration.passed` | Changes integrated into canonical workspace. |
| `integration.failed` | Integration rejected due to conflict or test failure. |

## Event Replay & Gap Detection

Events are assigned a monotonically increasing `sequence` number per task in SQLite.

If a client requests replay starting from a sequence older than the oldest retained event in the database (due to retention cleanup), the server emits a `task.replay_gap` warning event:

```json
{
  "type": "task.replay_gap",
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "requestedAfterSequence": 10,
  "oldestAvailableSequence": 45,
  "timestamp": "2026-10-25T04:15:00.000Z"
}
```

The client should synchronize its current state using REST (`GET /tasks/:id`) and continue streaming from the latest sequence.
