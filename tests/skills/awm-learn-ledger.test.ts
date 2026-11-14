import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const LEDGER = join(__dirname, '..', '..', 'skills', 'awm-learn', 'scripts', 'ledger.mjs');
let root: string;
let learnDir: string;

const files: Record<string, string> = {
  'README.md': '# Club app\n',
  'src/billing.ts': [
    'export function charge() {}',
    '// We retry three times because the processor drops about 1% of first attempts (PAY-112).',
    'const RETRIES = 3;',
    '// handles the case where a fee is superseded by a newer fee',
    'export const superseded = true;',
  ].join('\n'),
  'src/billing.test.ts': "it('retries', () => { const d = '2010-01-01'; });\n",
  'src/crypto/medical.ts': 'export const encrypt = () => {};\n',
  'src/scripts/upload-backup.ts': 'export {};\n',
  'db/migrations/001_init.sql': 'create table fee (id int);\n',
  'docs/adr/0003-retry-policy.md': '# ADR 3: retry policy\n\nStatus: Accepted\n\n## Context\nx\n\n## Decision\nRetry 3 times.\n\n## Consequences\ny\n',
  'docs/minutes/2026-03-14-board.md': '# Board meeting\n\nAttendees: A, B\n\nDecision: adopt the new fee.\nAction: B to update the policy.\n',
  'docs/fee-policy-old.md': '# Fee policy (old)\n',
  'docs/spec-2025.md': '> Superseded by spec-2026.md\n\n# Spec\nThe system shall bill monthly.\n',
  'docs/requirements.md': '# Requirements\nREQ-1 The system shall bill.\n',
  'docs/drafts/ideas.md': '# ideas\n',
  'backups/members-export.json': '[]\n',
  'docs/handbook.pdf': '%PDF-1.4 fake',
};

const run = (...args: string[]) => execFileSync('node', [LEDGER, ...args], { encoding: 'utf8', env: { ...process.env, AWM_LEARN_DIR: learnDir } });
const survey = () => JSON.parse(run('survey', root, '--json'));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'awm-learn-corpus-'));
  learnDir = mkdtempSync(join(tmpdir(), 'awm-learn-ledgers-'));
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
});
afterAll(() => { for (const d of [root, learnDir]) try { rmSync(d, { recursive: true, force: true }); } catch {} });

describe('awm-learn survey', () => {
  it('assigns each file a role from its path and text', () => {
    run('plan', root, '--project', 't');
    const L = JSON.parse(require('node:fs').readFileSync(join(learnDir, 't', 'ledger.json'), 'utf8'));
    const roleOf = (p: string) => L.units.find((u: any) => u.files.includes(p))?.role;
    expect(roleOf('src/billing.ts')).toBe('source');
    expect(roleOf('db/migrations/001_init.sql')).toBe('migration');
    expect(roleOf('docs/adr/0003-retry-policy.md')).toBe('decision');
    expect(roleOf('docs/minutes/2026-03-14-board.md')).toBe('minutes');
  });

  it('flags status only where authors state it, never from code that mentions it', () => {
    const r = survey();
    expect(r.approved).toContain('docs/adr/0003-retry-policy.md');
    expect(r.superseded).toEqual(['docs/spec-2025.md']);          // not src/billing.ts
    expect(r.archived).toEqual(['docs/fee-policy-old.md']);        // not upload-backup.ts
    expect(r.drafts).toEqual(['docs/drafts/ideas.md']);
  });

  it('holds back likely-sensitive data but not code about the same subject', () => {
    const r = survey();
    expect(r.skipped.sensitive).toBe(1);
    expect(r.skipped.sensitivePaths).toEqual(['backups/members-export.json']);
  });

  it('reads dates from documents, not from test data inside code', () => {
    const r = survey();
    expect(r.dateRange?.from).not.toBe('2010-01-01');
    expect(r.datedDocuments).toBeGreaterThanOrEqual(1);              // the minutes' file name
  });

  it('counts PDFs as documents to read, not binaries to skip', () => {
    const r = survey();
    expect(r.kinds.document).toBe(1);
  });

  it('finds the why-comments in code and the decision lines in minutes', () => {
    const out = JSON.parse(run('next', '--project', 't', '--n', '50', '--agent', 'x'));
    const billing = out.find((u: any) => u.files.includes('src/billing.ts'));
    expect(billing.markers.join(' ')).toMatch(/src\/billing\.ts:2\b/);
    const minutes = out.find((u: any) => u.files.includes('docs/minutes/2026-03-14-board.md'));
    expect(minutes.markers.join(' ')).toMatch(/:5,6/);
    expect(minutes.date).toBe('2026-03-14');
  });

  it('ranks decision records above superseded and archived material', () => {
    const L = JSON.parse(require('node:fs').readFileSync(join(learnDir, 't', 'ledger.json'), 'utf8'));
    const pr = (p: string) => L.units.find((u: any) => u.files.includes(p)).priority;
    expect(pr('docs/adr/0003-retry-policy.md')).toBeGreaterThan(pr('docs/spec-2025.md'));
  });

  it('records measured cost against the estimate', () => {
    run('plan', root, '--project', 'c', '--force');
    const [u] = JSON.parse(run('next', '--project', 'c', '--n', '1', '--agent', 'x'));
    run('done', u.id, '--project', 'c', '--memories', '2', '--tokens', '20000');
    expect(run('status', '--project', 'c')).toMatch(/measured cost: 1 units used 20k tokens/);
  });
});
