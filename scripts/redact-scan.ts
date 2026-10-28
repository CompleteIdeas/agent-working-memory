// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Read-only scan of a memory store with the write-time redaction rules (S1).
 *
 * Answers two questions the labelled fixture cannot: how often each rule fires on memories
 * written the way agents really write, and what the hits look like — so false positives can
 * be judged on real text. Samples are OFF by default. With --samples N they are printed after
 * masking, but the surrounding words are real text, so a credential the rules MISSED can show
 * up in a window (the first live scan printed one this way). Use samples only where you
 * would be willing to see a secret.
 *
 *   npx tsx scripts/redact-scan.ts [path/to/memory.db] [--samples N]
 *
 * Opens the database read-only. It changes nothing; a backfill is a separate decision.
 */
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith('--')) ?? process.env.AWM_DB_PATH ?? join(homedir(), '.awm', 'memory.db');
const samplesArg = args.indexOf('--samples');
const SAMPLES = samplesArg >= 0 ? Number(args[samplesArg + 1]) : 0;

// Report everything, mask nothing in the source text: we compute findings on the original,
// then print a masked window. Force mask mode so the printed window is the redacted form.
process.env.AWM_REDACT = 'mask';
process.env.AWM_REDACT_PII = 'mask';
const { redactText } = await import('../src/core/redact.js');

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db.prepare(`SELECT id, stage, concept, content, tags FROM engrams`).all() as Array<{
  id: string; stage: string; concept: string; content: string; tags: string;
}>;

const byType = new Map<string, { engrams: Set<string>; hits: number; samples: string[] }>();
let engramsWithAny = 0;

for (const row of rows) {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags ?? '[]'); } catch { /* ignore */ }
  let any = false;
  // Tags are redacted one at a time on the real write path, so scan them that way: joining
  // them with ' | ' made a table separator that real writes never see.
  for (const [field, text] of [['concept', row.concept], ['content', row.content], ...tags.map((t) => ['tags', t] as const)]) {
    const r = redactText(text ?? '');
    if (r.findings.length === 0) continue;
    any = true;
    for (const f of r.findings) {
      const e = byType.get(f.type) ?? { engrams: new Set(), hits: 0, samples: [] };
      e.engrams.add(row.id);
      e.hits++;
      if (e.samples.length < SAMPLES) {
        // Window around the first mask of this type, from the REDACTED text.
        const marker = `[REDACTED:${f.type}`;
        const at = r.text.indexOf(marker);
        const from = Math.max(0, at - 60);
        const to = Math.min(r.text.length, at + marker.length + 60);
        // Blank every long token-shaped string in the window too, matched or not, so a
        // credential the rules missed cannot be printed. Labels and words stay readable.
        const window = r.text.slice(from, to)
          .replace(/\s+/g, ' ')
          .replace(/(?<!\[REDACTED:[a-z_]*)\b[A-Za-z0-9_+/=-]{6,}\b/g, (t) => (/\d/.test(t) && /[A-Za-z]/.test(t) ? '‹token›' : t));
        e.samples.push(`  ${row.id.slice(0, 8)} ${row.stage.padEnd(8)} ${field.padEnd(7)} …${window}…`);
      }
      byType.set(f.type, e);
    }
  }
  if (any) engramsWithAny++;
}

console.log(`Store: ${dbPath}`);
console.log(`Engrams scanned: ${rows.length}; with at least one finding: ${engramsWithAny}\n`);
for (const [type, e] of [...byType].sort((a, b) => b[1].hits - a[1].hits)) {
  console.log(`${type.padEnd(22)} ${String(e.hits).padStart(5)} hits in ${String(e.engrams.size).padStart(5)} engrams`);
  for (const s of e.samples) console.log(s);
  console.log('');
}
db.close();
