# awm — Agent Instructions

## Memory (AWM)
You have persistent memory via the agent-working-memory MCP server.

### Lifecycle (always do these)
- Session start: call memory_restore to recover previous context
- Starting a task: call memory_task_begin (checkpoints + recalls relevant memories)
- Finishing a task: call memory_task_end with a summary
- Auto-checkpoint: hooks handle compaction, session end, and 15-min timer (no action needed)

### Write memory when:
- A project decision is made or changed
- A root cause is discovered after debugging
- A reusable implementation pattern is established
- A user preference, constraint, or requirement is clarified
- A prior assumption is found to be wrong
- A significant piece of work is completed

### Recall memory when:
- Starting work on a new task or subsystem
- Re-entering code you haven't touched recently
- After a failed attempt — check if there's prior knowledge
- Before refactoring or making architectural changes
- When a topic comes up that you might have prior context on

### Also:
- After using a recalled memory: call memory_feedback (useful/not-useful)
- To correct wrong info: call memory_retract or memory_supersede
- To track work items: memory_task_add, memory_task_update, memory_task_list, memory_task_next
