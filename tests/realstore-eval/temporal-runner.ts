/**
 * Does a temporal cue in the query help, hurt, or do nothing?
 *
 * Each probe is asked five ways against the identical corpus. Only the
 * temporal phrasing differs, so any delta is attributable to it:
 *
 *   none          "subject"                        <- control
 *   relativeDay   "subject from last Friday"
 *   relativeWeek  "subject from last week"
 *   absoluteDate  "subject on 2026-05-01"
 *   absoluteMonth "subject in May 2026"
 *
 * Prediction going in (recorded before running): the cues do nothing or HURT.
 * Nothing parses dates from the query, so the extra words are ordinary BM25
 * tokens diluting the subject terms. `absoluteDate` may help slightly by
 * accidentally matching a `date=` tag or a date written into the body.
 *
 * ORACLE arm: restrict candidates to the memory's own ISO week, which is what a
 * working temporal filter would approximate. Gold is unique-by-subject within
 * its week by construction, so this bounds the achievable gain.
 *
 * Run: npx tsx tests/realstore-eval/temporal-runner.ts
 */
import { readFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { recallConfigFingerprint } from '../../src/core/recall-config.js';

const SNAP = join(import.meta.dirname, 'snapshot', 'store.db');
const FIX = join(import.meta.dirname, 'fixture-temporal.json');
const WORK = join(tmpdir(), `awm-temporal-${process.pid}.db`);
const K = Number(process.env.TEMPORAL_K ?? 10);

const PHRASINGS = ['none', 'relativeDay', 'relativeWeek', 'absoluteDate', 'absoluteMonth'] as const;

async function main() {
  const fx = JSON.parse(readFileSync(FIX, 'utf8'));
  const limit = Number(process.env.TEMPORAL_LIMIT ?? fx.items.length);
  const items = fx.items.slice(0, limit);

  for (const s of ['', '-wal', '-shm']) { try { if (existsSync(WORK + s)) unlinkSync(WORK + s); } catch {} }
  copyFileSync(SNAP, WORK);
  const store = new EngramStore(WORK);
  const act = new ActivationEngine(store);

  console.log(`\nTEMPORAL CUE EVAL · arm=${recallConfigFingerprint()} · ${items.length} probes, k=${K}\n`);
  console.log('  phrasing         s@1     s@5     MRR     example');
  console.log('  ' + '-'.repeat(88));

  const results: Record<string, { s1: number; s5: number; rr: number }> = {};
  for (const ph of PHRASINGS) {
    let s1 = 0, s5 = 0, rr = 0;
    for (const it of items) {
      const res: any[] = await act.activate({
        agentId: 'work', context: it.phrasings[ph], limit: K, internal: true,
        // Anchor relative phrasing to the fixture, not the wall clock, or
        // "last Friday" would mean something different on every run.
        asOf: new Date(it.asOf + 'T12:00:00Z').getTime(),
      } as any);
      const i = res.findIndex(r => r.engram.id === it.goldId);
      if (i === 0) s1++;
      if (i >= 0 && i < 5) s5++;
      if (i >= 0) rr += 1 / (i + 1);
    }
    results[ph] = { s1, s5, rr };
    const n = items.length;
    console.log(
      `  ${ph.padEnd(15)} ${(100 * s1 / n).toFixed(1).padStart(5)}%  ${(100 * s5 / n).toFixed(1).padStart(5)}%  ` +
      `${(100 * rr / n).toFixed(1).padStart(5)}%   "${String(items[0].phrasings[ph]).slice(0, 44)}"`);
  }

  // ORACLE: what a working temporal filter would approximate — candidates
  // restricted to the memory's own week. Bounds the achievable gain.
  let oracle1 = 0;
  const all: any[] = store.getEngramsByAgents(['work', 'personal'], 'active') as any[];
  const wk = (iso: string) => {
    const d = new Date(iso);
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return `${t.getUTCFullYear()}-W${String(Math.ceil(((((t as any) - (y0 as any)) / 86400000) + 1) / 7)).padStart(2, '0')}`;
  };
  for (const it of items) {
    const inWeek = all.filter(e => {
      const c = e.createdAt ?? e.created_at;
      return c && wk(c) === it.week;
    });
    // Subject terms vs that week's memories only.
    const terms = String(it.subject).toLowerCase().split(/\s+/).filter(Boolean);
    const scored = inWeek.map(e => {
      const hay = `${e.concept ?? ''} ${e.content ?? ''}`.toLowerCase();
      return { id: e.id, n: terms.filter(t => hay.includes(t)).length };
    }).sort((a, b) => b.n - a.n);
    if (scored[0]?.id === it.goldId) oracle1++;
  }

  store.close?.();
  for (const s of ['', '-wal', '-shm']) { try { if (existsSync(WORK + s)) unlinkSync(WORK + s); } catch {} }

  const n = items.length;
  const base = results.none;
  console.log('  ' + '-'.repeat(88));
  console.log(`  ORACLE (week-filtered)  ${(100 * oracle1 / n).toFixed(1)}%  <- ceiling a working temporal filter approaches\n`);
  console.log('  READING:');
  for (const ph of PHRASINGS.slice(1)) {
    const d = 100 * (results[ph].s1 - base.s1) / n;
    console.log(`    ${ph.padEnd(15)} ${d >= 0 ? '+' : ''}${d.toFixed(1)}pp vs no temporal cue`);
  }
  console.log(`    ORACLE          +${(100 * (oracle1 - base.s1) / n).toFixed(1)}pp  <- what is being left on the table`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
