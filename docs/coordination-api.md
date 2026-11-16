# Coordination API Reference

All endpoints are at the root of `http://127.0.0.1:8400`. Enabled via `AWM_COORDINATION=true`.
Routes are defined in `src/coordination/routes.ts` (`registerCoordinationRoutes`); request schemas in
`src/coordination/schemas.ts`. Every route except `/health` is rate-limited to 300 requests per
minute per agent (429 beyond that).

### Session tokens

`POST /checkin` returns a `sessionToken` (a fresh one when a dead agent reconnects, the stored one on
a live heartbeat). Routes that act as an agent — `POST /checkout`, `PATCH /pulse`,
`POST /assignment/:id/claim`, `POST /lock`, `DELETE /lock`, `POST /finding` and `POST /decisions` —
check it when the caller sends it in the `x-session-token` header: a mismatch returns `403
{"error": "invalid session token"}`. A request **without** the header passes by default, for
workers that never send tokens; set `AWM_COORD_REQUIRE_TOKENS=1` to reject it. (Agent rows written
before tokens existed have no token and always pass.)

### MCP tools

With `AWM_COORDINATION=true` (or `1`), the MCP server also registers **13 `coord_*` tools**
(`src/coordination/mcp-tools.ts`, `registerCoordinationTools`): `coord_checkin`, `coord_checkout`,
`coord_assign`, `coord_assignment`, `coord_assignment_update`, `coord_lock`, `coord_unlock`,
`coord_locks`, `coord_command`, `coord_command_poll`, `coord_workers`, `coord_finding`,
`coord_status`. They are not counted in the 22 memory tools.

## Agents

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| POST | `/checkin` | `{name, role?, pid?, metadata?, capabilities?, workspace?, channelUrl?}` | `{agentId, sessionToken, action, status, workspace}` (201 on first registration) |
| POST | `/checkout` | `{agentId}` | `{ok}` |
| POST | `/shutdown` | — | `{ok, agents_marked_offline}` — marks every live agent dead, releases their locks, checkpoints the WAL |
| PATCH | `/pulse` | `{agentId}` | `{ok}` |
| POST | `/next` | `{name, role?, workspace?, capabilities?}` | `{agentId, status, assignment, commands}` |
| GET | `/workers` | `?capability=&status=&workspace=` | `{workers, count}` |
| GET | `/agent/:id` | — | `{agent, assignment, locks}` |
| DELETE | `/agent/:id` | — | `{ok}` |

## Assignments

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| POST | `/assign` | `{agentId?, worker_name?, task, description?, workspace?, priority?, blocked_by?, context?}` | `{assignmentId, status}` |
| GET | `/assignment` | `?agentId=&name=&workspace=` | `{assignment}` |
| GET | `/assignment/:id` | — | `{assignment}` |
| GET | `/assignments` | `?status=&workspace=&agent_id=&limit=&offset=` | `{assignments, total}` |
| POST | `/assignment/:id/claim` | `{agentId}` | `{ok}` |
| PATCH | `/assignment/:id` | `{status, result?, commit_sha?}` | `{ok}` |
| PUT | `/assignment/:id` | `{status, result?, commit_sha?}` | `{ok}` |
| POST | `/assignment/:id/update` | `{status, result?, commit_sha?}` | `{ok}` |
| POST | `/assignment/:id/fail` | `{result?, mode?}` | `{ok, outcome, attempt_count, last_failure_mode}` — retries or fails the assignment by failure mode and records a circuit-breaker failure; 400 if already `completed`/`failed` |
| POST | `/reassign` | `{assignmentId, targetAgentId?, target_worker_name?}` | `{ok, assignmentId, newAgentId, status}` |

## Locks

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| POST | `/lock` | `{agentId, filePath, reason?}` | `{ok, action}` or `409` |
| DELETE | `/lock` | `{agentId, filePath}` | `{ok}` |
| GET | `/locks` | — | `{locks}` |

## Commands

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| POST | `/command` | `{command, reason?, issuedBy?, workspace?}` | `{ok, command}` |
| GET | `/command` | `?workspace=` | `{active, command?, commands}` |
| DELETE | `/command/:id` | — | `{ok}` |
| GET | `/command/wait` | `?status=&timeout=&workspace=` | `{ready, agents}` |

## Findings

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| POST | `/finding` | `{agentId, category, severity?, filePath?, lineNumber?, description, suggestion?}` | `{findingId}` |
| GET | `/findings` | `?category=&severity=&status=&limit=` | `{findings}` |
| GET | `/findings/summary` | — | `{total, bySeverity, byCategory}` |
| POST | `/finding/:id/resolve` | — | `{ok}` |
| PATCH | `/finding/:id` | `{status?, severity?, suggestion?}` | `{ok}` |

## Decisions

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| GET | `/decisions` | `?since_id=&assignment_id=&workspace=&limit=` | `{decisions}` |
| POST | `/decisions` | `{agentId, assignment_id?, tags?, summary}` | `{ok, id}` |

## Events & Timeline

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| GET | `/events` | `?since_id=&agent_id=&event_type=&limit=` | `{events}` |
| GET | `/timeline` | `?limit=&since=` | `{timeline}` |

## Stale Agent Management

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| GET | `/stale` | `?seconds=&cleanup=` | `{stale, cleaned?}` |
| POST | `/stale/cleanup` | `?seconds=` | `{stale, cleaned}` |

## Monitoring

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| GET | `/status` | — | `{agents, assignments, locks, stats, recentFindings}` |
| GET | `/stats` | — | `{workers, tasks, decisions, uptime_seconds}` |
| GET | `/metrics` | — | Prometheus text format |
| GET | `/health/deep` | — | `{status, db_healthy, agents_alive, stale_agents, pending_tasks, uptime_seconds, wal_size_bytes, wal_autocheckpoint}` (detail below) |
| GET | `/telemetry/channels` | — | Channel push delivery counters since start (`attempts`, `delivered`, `failed_http`, `failed_unreachable`, `no_session`, `fallback_mailbox`, `session_disconnects`, `delivery_rate`) and `per_agent` rows |

## Channel Sessions

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| POST | `/channel/register` | `{agentId, channelId}` | `{ok}` (404 if the agent is unknown) |
| DELETE | `/channel/register` | `{agentId}` | `{ok}` |
| POST | `/channel/push` | `{agentId, message}` or `{role, workspace, message}` | `{ok, delivered: true, channelId}`, or `{ok, delivered: false, queued: true}` when it fell back to the mailbox (delivered on the next `/next`); 423 when the worker's circuit is open |
| GET | `/channel/sessions` | — | `{sessions}` (connected only) |
| POST | `/channel/probe` | — | `{probed, alive, dead, results}`; unreachable sessions are marked disconnected |

`POST /checkin` with `channelUrl` registers the channel session in the same call.

## Status Values

- **Agent status:** `idle`, `working`, `dead`
- **Assignment status:** `pending`, `assigned`, `in_progress`, `completed`, `failed`, `blocked`
- **Commands:** `BUILD_FREEZE`, `PAUSE`, `RESUME`, `SHUTDOWN`
- **Finding severity:** `critical`, `error`, `warn`, `info`

---

## Detailed Reference

### POST /assign — `context` field

The `context` field lets the coordinator attach structured metadata to an assignment. Workers receive it through `/next` and can use it to orient themselves before polling AWM.

**Schema** (`assignCreateSchema`):

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `agentId` | UUID string | No | Must match a live agent |
| `worker_name` | string | No | Resolved to agentId; fallback if agentId not given |
| `task` | string | **Yes** | 1–1000 chars |
| `description` | string | No | Up to 5000 chars |
| `workspace` | string | No | Up to 50 chars |
| `priority` | integer | No | 0–10 (default `0`; higher = picked first by `/next`) |
| `blocked_by` | UUID string | No | Assignment ID that must complete first |
| `context` | JSON string | No | Up to 10 000 chars; must be valid JSON |

**`context` JSON bridge:**

When `context` is provided and coordination is started with an AWM `store`, the server parses it and writes a canonical AWM engram so workers can recall context via `memory_recall`. Recognized top-level keys: `files`, `references`, `decisions`, `acceptance_criteria`; any other keys are also included.

```json
{
  "files": ["src/api/routes.ts", "tests/integration/foo.test.ts"],
  "references": ["TICKET-123"],
  "decisions": ["use Zod for validation"],
  "acceptance_criteria": "all tests pass"
}
```

**Response** (`201`):

```json
{ "assignmentId": "uuid", "status": "assigned" | "pending", "pushed": false }
```

- `status` is `"assigned"` if an agent was targeted, `"pending"` if no agent (picked up via `/next`)
- `pushed` is `true` if the targeted agent has an active channel session

**Error responses:**

| Code | Condition |
|------|-----------|
| `400` | Validation failure |
| `404` | `worker_name` not found |
| `409` | Targeted agent already has an active assignment |

**Example:**

```bash
curl -X POST http://127.0.0.1:8400/assign \
  -H 'Content-Type: application/json' \
  -d '{
    "worker_name": "Worker-C",
    "task": "Fix auth middleware",
    "description": "JWT tokens are not validated on /api/admin routes.",
    "priority": 5,
    "context": "{\"files\":[\"src/middleware/auth.ts\"],\"acceptance_criteria\":\"all auth tests pass\"}"
  }'
```

---

### POST /decisions — cross-agent decision propagation

Records a decision made by an agent so other agents can discover it during `memory_recall` (see peer-decisions injection in AWM).

**Request schema** (`decisionCreateSchema`):

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `agentId` | UUID string | **Yes** | Must be a registered agent |
| `assignment_id` | string | No | Up to 100 chars; links to an assignment for context |
| `tags` | string | No | Up to 500 chars; comma-separated e.g. `"auth,security"` |
| `summary` | string | **Yes** | 1–5000 chars; the decision statement |

**Response** (`201`):

```json
{ "ok": true, "id": 42 }
```

`id` is the auto-increment integer primary key of the new row.

**Error responses:**

| Code | Condition |
|------|-----------|
| `400` | Validation failure |
| `404` | `agentId` not found in `coord_agents` |

**GET /decisions query params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `since_id` | integer | `0` | Return only rows with `id > since_id` (pagination cursor) |
| `assignment_id` | string | — | Filter to decisions for a specific assignment |
| `workspace` | string | — | Filter to decisions authored by agents in this workspace |
| `limit` | integer | `20` | Max rows (1–200) |

Results are ordered by `created_at ASC`.

**Example:**

```bash
# Write a decision
curl -X POST http://127.0.0.1:8400/decisions \
  -H 'Content-Type: application/json' \
  -d '{
    "agentId": "c78411b6-7a16-4f06-bd1f-5723371d3b44",
    "assignment_id": "bd65d0f2-c91e-433c-af06-20cd96ea7a22",
    "tags": "auth,security",
    "summary": "Use bearer tokens for all /api routes; skip /health"
  }'

# Read decisions since cursor
curl "http://127.0.0.1:8400/decisions?since_id=0&workspace=WORK&limit=10"
```

**`memory_write` auto-propagation:**

Decisions are also written automatically when an agent calls the MCP `memory_write` tool with `decision_made: true` — no explicit POST required. The MCP layer inserts into `coord_decisions` using the current agent's registered name.

---

### Coordination Event Emitter

Routes fire typed internal events via `CoordinationEventBus` (a typed `EventEmitter` wrapper defined in `src/coordination/events.ts`). These events decouple route handlers from side-effects such as channel push notifications and audit logging. External code can subscribe to the bus instance returned by `createEventBus()`.

**7 typed events:**

| Event | Fired when | Payload fields |
|-------|-----------|----------------|
| `agent.checkin` | `POST /checkin` succeeds | `agentId`, `name`, `role`, `workspace?` |
| `agent.checkout` | `POST /checkout` succeeds | `agentId`, `name` |
| `assignment.created` | `POST /assign` succeeds | `assignmentId`, `agentId`, `task`, `workspace?` |
| `assignment.updated` | Status transition on any assignment update endpoint | `assignmentId`, `agentId`, `status`, `result?` |
| `assignment.completed` | Status transitions to `completed` | `assignmentId`, `agentId`, `result` |
| `session.started` | `POST /channel/register` succeeds | `agentId`, `channelId` |
| `session.closed` | `DELETE /channel/register` succeeds | `agentId`, `channelId` |

**Subscribing (TypeScript):**

```typescript
import { createEventBus } from './coordination/events.js';

const bus = createEventBus();

bus.on('assignment.completed', ({ assignmentId, agentId, result }) => {
  console.log(`${agentId} completed ${assignmentId}: ${result}`);
});

bus.on('agent.checkin', ({ name, role, workspace }) => {
  console.log(`${name} (${role}) joined workspace ${workspace ?? 'default'}`);
});
```

**Notes:**
- Events fire after the DB write succeeds; listeners run synchronously in the same tick.
- `assignment.updated` fires on every status transition including intermediate ones (`assigned → in_progress`); `assignment.completed` fires only for the terminal `completed` status.
- The bus is opt-in — if `registerCoordinationRoutes()` is called without a bus argument, no events are emitted.

---

### GET /timeline

Returns a reverse-chronological activity log of all coordination events, joining agent names and their current assignment task.

**Query params** (`timelineQuerySchema`):

| Param | Type | Default | Constraints | Description |
|-------|------|---------|-------------|-------------|
| `limit` | integer | `50` | 1–200 | Max rows to return |
| `since` | ISO timestamp string | — | max 30 chars | Return only events at or after this time, e.g. `2026-03-26T16:00:00` |

**Response:**

```json
{
  "timeline": [
    {
      "timestamp": "2026-03-26 17:00:00",
      "agent_name": "Worker-C",
      "event_type": "assignment_claimed",
      "detail": "auto-claimed assignment bd65d0f2 via /next",
      "assignment_task": "Expand coordination API docs"
    }
  ]
}
```

Results are ordered `created_at DESC, id DESC` (newest first).

**`event_type` values** (written by route handlers to `coord_events`):

| Value | Written by |
|-------|-----------|
| `checkin` | `POST /checkin` |
| `checkout` | `POST /checkout` |
| `assignment_created` | `POST /assign` |
| `assignment_claimed` | `POST /next` (auto-claim) |
| `assignment_claimed` | `POST /assignment/:id/claim` |
| `lock_acquired` | `POST /lock` |
| `lock_released` | `DELETE /lock` |
| `channel_register` | `POST /channel/register` |
| `channel_deregister` | `DELETE /channel/register` |

**Example:**

```bash
# Last 20 events
curl "http://127.0.0.1:8400/timeline?limit=20"

# Events since a specific time
curl "http://127.0.0.1:8400/timeline?since=2026-03-26T16:00:00&limit=50"
```

---

### GET /health/deep

Deep health check that inspects the SQLite database, agent liveness, and WAL file state. Suitable for automated monitoring and alerting.

**Query params:** none

**Response:**

```json
{
  "status": "ok",
  "db_healthy": true,
  "agents_alive": 3,
  "stale_agents": 0,
  "pending_tasks": 1,
  "uptime_seconds": 4320,
  "wal_size_bytes": 32768,
  "wal_autocheckpoint": 1000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok"` \| `"degraded"` | `"degraded"` if DB integrity fails or `stale_agents > 2` |
| `db_healthy` | boolean | The memory store's `integrityCheck()` (`true` when coordination runs without a store) |
| `agents_alive` | integer | Agents where `status != 'dead'` |
| `stale_agents` | integer | Live agents unseen for more than 300 seconds |
| `pending_tasks` | integer | Assignments in `pending`, `assigned`, or `in_progress` |
| `uptime_seconds` | integer | Seconds since the earliest live agent's `started_at` |
| `wal_size_bytes` | integer \| null | WAL file size in bytes; `null` if WAL file absent |
| `wal_autocheckpoint` | integer \| null | Current `wal_autocheckpoint` pragma value |

**Degraded conditions:**

| Condition | Meaning |
|-----------|---------|
| `db_healthy: false` | SQLite integrity check failed — investigate immediately |
| `stale_agents > 2` | Three or more agents have gone silent; possible crash or network issue |

**Example:**

```bash
curl http://127.0.0.1:8400/health/deep
```
