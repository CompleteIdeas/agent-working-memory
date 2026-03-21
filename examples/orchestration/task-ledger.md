# Task Ledger Pattern

AWM includes built-in task management that stores tasks as memories with special fields. This pattern shows how to use it for multi-step workflows.

## How It Works

Tasks are stored as engrams (memories) with additional fields:
- `taskStatus`: open, in_progress, blocked, done
- `taskPriority`: urgent, high, medium, low
- `blockedBy`: ID of a blocking task

Tasks bypass the salience filter (always stored) and are auto-tagged with "task".

## MCP Tools

```
memory_task_add      — Create a task with priority
memory_task_update   — Change status/priority
memory_task_list     — List tasks by status
memory_task_next     — Get highest-priority actionable task
memory_task_begin    — Start a task (auto-checkpoints, recalls context)
memory_task_end      — Complete a task (writes summary, checkpoints)
```

## Workflow Example

### 1. Plan work as tasks

```
memory_task_add: "Migrate user table to new schema" (priority: high)
memory_task_add: "Update API endpoints for new schema" (priority: high)
memory_task_add: "Add migration rollback script" (priority: medium)
memory_task_add: "Update integration tests" (priority: medium)
```

### 2. Start working

```
memory_task_next  → Returns "Migrate user table to new schema"
memory_task_begin: topic="Migrate user table"
  → Auto-checkpoints current state
  → Recalls any prior context about user table, migrations
```

### 3. During work

If you discover a dependency:
```
memory_task_update: "Update API endpoints" → blocked_by: [migration task ID]
```

Write discoveries as regular memories:
```
memory_write: "User table has 3 foreign key constraints that need CASCADE updates"
```

### 4. Complete and continue

```
memory_task_end: summary="Migrated user table: added new columns, updated FKs, ran on staging"
memory_task_next  → Returns next highest-priority unblocked task
```

## HTTP API Equivalent

```bash
# Create task
curl -X POST http://localhost:8400/task/create \
  -H "Content-Type: application/json" \
  -d '{"agentId": "my-agent", "concept": "Migrate user table", "priority": "high"}'

# Get next task
curl http://localhost:8400/task/next/my-agent

# Update status
curl -X POST http://localhost:8400/task/update \
  -H "Content-Type: application/json" \
  -d '{"agentId": "my-agent", "taskId": "abc123", "status": "done"}'

# List all tasks
curl http://localhost:8400/task/list/my-agent
```

## Benefits

- **Survives context compaction**: Tasks are memories, so they persist across sessions
- **Priority ordering**: `task_next` always returns the most important unblocked work
- **Context recall**: `task_begin` automatically recalls related prior knowledge
- **Audit trail**: Completed tasks with summaries form a work history
- **Blocking**: Express dependencies between tasks without external tools
