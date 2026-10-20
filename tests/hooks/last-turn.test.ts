import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastAssistantTurnText } from '../../src/hooks/sidecar.js';

const line = (o: unknown) => JSON.stringify(o);

describe('lastAssistantTurnText', () => {
  it('returns the assistant text and tool calls since the previous user message, skipping tool results', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awm-turn-'));
    const p = join(dir, 't.jsonl');
    writeFileSync(p, [
      line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'earlier question' }] } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer about port 9999' }] } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'which port does the API use?' }] } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl localhost:4100/health' } }] } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The RosterKeep API listens on port 4100.' }] } }),
    ].join('\n'));
    const text = lastAssistantTurnText(p);
    expect(text).toContain('port 4100');
    expect(text).toContain('curl localhost:4100/health');
    expect(text).not.toContain('9999');
  });

  it('reads the older top-level-role shape too, and returns empty for a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awm-turn-'));
    const p = join(dir, 't.jsonl');
    writeFileSync(p, [
      line({ role: 'user', content: 'q' }),
      line({ role: 'assistant', content: 'the answer is 4100' }),
    ].join('\n'));
    expect(lastAssistantTurnText(p)).toBe('the answer is 4100');
    expect(lastAssistantTurnText(join(dir, 'missing.jsonl'))).toBe('');
  });
});
