/**
 * `awm setup` must never silently delete hand-written notes.
 *
 * WHY THIS EXISTS
 * ---------------
 * upsertAwmSection replaced everything between `## Memory (AWM)` and the next `## `
 * heading. Content above and below the section survived; content INSIDE it did not, and
 * no backup was taken.
 *
 * Measured against a real CLAUDE.md before this was fixed: the AWM section held 381
 * non-blank lines, of which 169 (44%) were not in the shipped template — the HTTP API
 * reliability finding, "a running MCP connection does not hot-reload" (0 of 51 recalls),
 * "call memory_whoami first", "only work and personal are valid workspaces". Every one
 * an operational fact that cost real debugging. `awm setup` would have deleted all of
 * them without a word.
 *
 * The contract now:
 *   - generated content is wrapped in explicit markers
 *   - only the marked range is ever replaced
 *   - an UNMARKED legacy section is backed up and NOT touched, unless force is passed
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upsertAwmSection, AWM_GEN_BEGIN, AWM_GEN_END } from '../../src/adapters/common.js';

const TEMPLATE = '## Memory (AWM) — MANDATORY\n\nUse the MCP server. Recall before guessing.\n';
const TEMPLATE_V2 = '## Memory (AWM) — MANDATORY\n\nUse the MCP server. Recall before guessing.\nAlso: chain recalls.\n';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'awm-upsert-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('upsertAwmSection', () => {
  it('creates a new file with the content wrapped in generated markers', () => {
    const f = join(dir, 'CLAUDE.md');
    upsertAwmSection(f, TEMPLATE, { titleIfNew: '# Global Instructions' });
    const out = readFileSync(f, 'utf-8');
    expect(out).toContain(AWM_GEN_BEGIN);
    expect(out).toContain(AWM_GEN_END);
    expect(out).toContain('Recall before guessing');
  });

  it('replaces ONLY the marked block, preserving notes elsewhere in the file', () => {
    const f = join(dir, 'CLAUDE.md');
    upsertAwmSection(f, TEMPLATE, { titleIfNew: '# Global' });
    const withNote = readFileSync(f, 'utf-8') + '\n\n## My own section\n\nDo not delete me.\n';
    writeFileSync(f, withNote);

    upsertAwmSection(f, TEMPLATE_V2);
    const out = readFileSync(f, 'utf-8');

    expect(out).toContain('Also: chain recalls');      // upgraded
    expect(out).toContain('Do not delete me.');        // survived
    expect(out).toContain('## My own section');
  });

  it('refuses to touch a legacy UNMARKED section, and writes a backup', () => {
    const f = join(dir, 'CLAUDE.md');
    // A file as it existed before markers: hand-edits interleaved with generated text.
    const legacy =
      '# Global Instructions\n\n## Memory (AWM) — MANDATORY\n\n' +
      'Use the MCP server.\n\n' +
      'Current build 0.12.2. HTTP API is unreliable as a bare background process.\n' +
      'A running MCP connection does not hot-reload — 0 of 51 recalls picked up a change.\n';
    writeFileSync(f, legacy);

    const msg = upsertAwmSection(f, TEMPLATE_V2);

    // nothing changed
    expect(readFileSync(f, 'utf-8')).toBe(legacy);
    expect(msg).toMatch(/NOT updated/);
    expect(msg).toMatch(/predates generated markers/);

    // and a backup exists carrying the original content
    const backups = readdirSync(dir).filter((n) => n.includes('.awm-backup-'));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(dir, backups[0]), 'utf-8')).toBe(legacy);
  });

  it('the hand-written findings survive the refusal — the whole point', () => {
    const f = join(dir, 'CLAUDE.md');
    const legacy =
      '# Global\n\n## Memory (AWM) — MANDATORY\n\nboilerplate\n\n' +
      'Only two valid workspaces exist: work and personal.\n';
    writeFileSync(f, legacy);
    upsertAwmSection(f, TEMPLATE_V2);
    expect(readFileSync(f, 'utf-8')).toContain('Only two valid workspaces exist');
  });

  it('force: true replaces a legacy section and leaves it marked for next time', () => {
    const f = join(dir, 'CLAUDE.md');
    writeFileSync(f, '# Global\n\n## Memory (AWM) — MANDATORY\n\nold text\n');
    const msg = upsertAwmSection(f, TEMPLATE_V2, { force: true });
    const out = readFileSync(f, 'utf-8');
    expect(msg).toMatch(/force/);
    expect(out).toContain(AWM_GEN_BEGIN);
    expect(out).toContain('Also: chain recalls');
    expect(out).not.toContain('old text');
  });

  it('is idempotent — a second identical upsert reports no change', () => {
    const f = join(dir, 'CLAUDE.md');
    upsertAwmSection(f, TEMPLATE, { titleIfNew: '# G' });
    const first = readFileSync(f, 'utf-8');
    const msg = upsertAwmSection(f, TEMPLATE);
    expect(msg).toMatch(/up-to-date/);
    expect(readFileSync(f, 'utf-8')).toBe(first);
  });

  it('appends markers when the file exists but has no AWM section', () => {
    const f = join(dir, 'CLAUDE.md');
    writeFileSync(f, '# My project\n\nSome existing rules.\n');
    upsertAwmSection(f, TEMPLATE);
    const out = readFileSync(f, 'utf-8');
    expect(out).toContain('Some existing rules.');
    expect(out).toContain(AWM_GEN_BEGIN);
  });
});
