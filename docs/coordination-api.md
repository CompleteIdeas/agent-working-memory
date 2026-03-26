# Coordination API Reference

All endpoints are at the root of `http://127.0.0.1:8400`. Enabled via `AWM_COORDINATION=true`.

## Agents

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| POST | `/checkin` | `{name, role?, pid?, capabilities?, workspace?}` | `{agentId, status, action}` |
| POST | `/checkout` | `{agentId}` | `{ok}` |
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
| GET | `/health/deep` | — | `{status, db, agents}` |

## Status Values

- **Agent status:** `idle`, `working`, `dead`
- **Assignment status:** `pending`, `assigned`, `in_progress`, `completed`, `failed`, `blocked`
- **Commands:** `BUILD_FREEZE`, `PAUSE`, `RESUME`, `SHUTDOWN`
- **Finding severity:** `critical`, `error`, `warn`, `info`
