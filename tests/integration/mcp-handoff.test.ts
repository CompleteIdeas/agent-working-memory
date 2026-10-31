// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * 0.22 through the real MCP server, over stdio, with the SDK's own client: the question
 * hand-off (declare → job → memory_set_questions → the job moves on) and the slot reply.
 * The first test in the repo that drives tool handlers in mcp.ts rather than the engines.
 *
 * Run: npx vitest run tests/integration/mcp-handoff.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const text = (r: any) => (r.content ?? []).map((c: any) => c.text ?? '').join('\n');

describe('MCP: question hand-off and slots', () => {
  let tmp: string; let client: Client;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'awm-mcp-handoff-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', join(import.meta.dirname, '..', '..', 'src', 'mcp.ts')],
      env: {
        ...process.env as Record<string, string>,
        AWM_DB_PATH: join(tmp, 'memory.db'), AWM_AGENT_ID: 'handoff-test', AWM_MODEL_DAEMON: '0',
        AWM_HOOK_PORT: '0', AWM_COORDINATION: 'false',
      },
      stderr: 'ignore',
    });
    client = new Client({ name: 'awm-handoff-test', version: '0.0.0' });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    try { await client.close(); } catch { /* closed */ }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('hands a declared host a question job, accepts the answers, and moves on', async () => {
    const w1 = text(await client.callTool({ name: 'memory_write', arguments: {
      concept: 'RosterKeep deploy command', content: 'Deploy with railway up --service rowos-app --ci after migrations.', memory_class: 'canonical' } }));
    const w2 = text(await client.callTool({ name: 'memory_write', arguments: {
      concept: 'Medical key backup', content: 'MEDICAL_ENCRYPTION_KEY is escrowed in the password manager.', memory_class: 'canonical' } }));
    const id1 = /ID: (\S+)/.exec(w1)?.[1]!, id2 = /ID: (\S+)/.exec(w2)?.[1]!;
    expect(id1 && id2).toBeTruthy();

    // No declaration, no job.
    expect(text(await client.callTool({ name: 'memory_restore', arguments: {} }))).not.toContain('Question job');

    const job = text(await client.callTool({ name: 'memory_restore', arguments: { capabilities: ['questions'] } }));
    expect(job).toContain('Question job (questions@1)');
    expect(job).toContain(id1);
    expect(job).toContain(id2);

    const set = text(await client.callTool({ name: 'memory_set_questions', arguments: { items: [
      { id: id1, questions: ['How do I ship the rowing club app to production?', 'What runs before a deploy?'] },
      { id: id2, questions: ['Where is the medical key backed up?'] },
      { id: 'not-a-real-id', questions: ['Anything at all here?'] },
    ] } }));
    expect(set).toContain('Questions set on 2 of 3 memories');
    expect(set).toContain('not one of your memories');
    expect(set).toContain('Coverage now 2 of 2');

    // Both are done, so the job has nothing left to hand out.
    expect(text(await client.callTool({ name: 'memory_restore', arguments: {} }))).not.toContain('Question job');
  }, 120_000);

  it('reports what a slot write did', async () => {
    const a = text(await client.callTool({ name: 'memory_write', arguments: {
      concept: 'Robert flight time', content: 'Flight to Lexington departs 10:15.', slot: 'robert.flight-time', memory_class: 'canonical' } }));
    expect(a).toContain('Slot robert.flight-time: this memory now holds it.');
    const b = text(await client.callTool({ name: 'memory_write', arguments: {
      concept: 'Robert flight time', content: 'Flight to Lexington now departs 8:40.', slot: 'robert.flight-time', memory_class: 'canonical' } }));
    expect(b).toMatch(/Slot robert\.flight-time: replaced "Robert flight time"/);
  }, 120_000);
});
