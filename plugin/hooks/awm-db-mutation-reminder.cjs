#!/usr/bin/env node
// AWM DB-mutation reminder hook (PostToolUse on Bash|PowerShell). Installed by awm setup.
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(raw || '{}');
    const cmd = (j.tool_input && j.tool_input.command) || '';
    const isDbClient = /\b(sqlcmd|mysql|psql)\b/i.test(cmd) || /(sqlcmd|mysql|psql)\.exe/i.test(cmd);
    const isMutation = /\b(INSERT|UPDATE|DELETE|ALTER|TRUNCATE|DROP|MERGE)\b/i.test(cmd);
    if (isDbClient && isMutation) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            'AWM REMINDER: this command contains a production DB mutation (INSERT/UPDATE/DELETE/ALTER/DROP/TRUNCATE/MERGE). ' +
            'The change is NOT complete until it is recorded: call memory_write NOW with the table, what changed, row counts, date, and why ' +
            '(memory_class canonical if other agents must recall it), and confirm a rollback/backup exists. ' +
            'If the keywords were only in a string/comment or on temp tables (#...), no write is needed.',
        },
      }));
    }
  } catch (e) { /* never block the tool result */ }
  process.exit(0);
});
