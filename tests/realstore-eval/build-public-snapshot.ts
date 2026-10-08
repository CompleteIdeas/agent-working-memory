/**
 * Build the PUBLIC benchmark snapshot — the one anyone can reproduce.
 *
 * Seeds a synthetic corpus (tests/realstore-eval/public-corpus.mjs) through the
 * real write pipeline, so the resulting store carries real embeddings, real
 * auto-tagging and real salience features rather than hand-stuffed rows. The
 * output is snapshot/public-store.db, which the ordinary runner and the
 * ordinary ground-truth builder then treat exactly like the private snapshot.
 *
 *   npm run bench:public:build          # ~70s for the default 400 memories
 *   PUBLIC_CORPUS_N=1200 npm run bench:public:build
 *
 * Then:
 *   npm run bench:public                # derive truth + score, end to end
 *
 * WHY THE WRITES ARE NOT REINFORCED
 * ---------------------------------
 * `performWrite` merges a near-duplicate into an existing engram instead of
 * creating a new one — correct product behaviour, wrong for a fixture builder.
 * This corpus is deliberately dense with same-domain neighbours that share
 * filler vocabulary, so reinforcement would quietly collapse several hundred
 * memories into a few dozen and the corpus size would stop matching what the
 * generator asked for. Reinforcement is therefore disabled HERE ONLY. The
 * recall path under test is untouched by this.
 *
 * WHY created_at IS REWRITTEN AFTERWARDS
 * -------------------------------------
 * `createEngram` stamps every row with the wall clock, so a corpus seeded in
 * one pass has no age spread at all — which would switch off ACT-R decay, one
 * of the things being measured. The real store spans months. So ages are
 * spread deterministically across a 180-day window ending at a fixed instant,
 * and the newest row lands exactly on that instant. The runner pins its decay
 * clock to `MAX(created_at)`, so the snapshot dates itself and every run sees
 * an identical store without anyone having to pass REALSTORE_NOW.
 */
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';
// @ts-expect-error — plain-JS sibling, intentionally dependency-free
import { buildPublicCorpus } from './public-corpus.mjs';

const SNAP_DIR = join(import.meta.dirname, 'snapshot');
// Name is selectable so a second-seed verification run can be built alongside
// the committed one instead of overwriting it. Same var the runner reads.
const DB = join(SNAP_DIR, process.env.REALSTORE_SNAPSHOT ?? 'public-store.db');

/** Newest engram lands exactly here, so the runner's auto-pinned clock is stable. */
const NEWEST = Date.parse('2026-10-01T12:00:00.000Z');
/** Age spread, matching the real store's roughly six-month span. */
const SPAN_DAYS = 180;

async function main() {
  const n = Number(process.env.PUBLIC_CORPUS_N ?? 400);
  const seed = Number(process.env.PUBLIC_CORPUS_SEED ?? 20261008);

  mkdirSync(SNAP_DIR, { recursive: true });
  for (const ext of ['', '-wal', '-shm']) {
    try { if (existsSync(DB + ext)) unlinkSync(DB + ext); } catch { /* fresh build is best-effort */ }
  }

  const corpus = buildPublicCorpus(n, seed);
  const store = new EngramStore(DB);
  const activation = new ActivationEngine(store);
  const connections = new ConnectionEngine(store, activation);

  process.stderr.write(`seeding ${corpus.length} memories into public-store.db (one real embedding each)...\n`);

  const ids: string[] = [];
  let wrote = 0;
  for (const m of corpus) {
    const res: any = await performWrite({ store, connectionEngine: connections } as any, {
      agentId: m.agent,
      concept: m.concept,
      content: m.content,
      project: 'Harborview',
      topic: m.topic,
      intent: 'finding',
      confidenceLevel: 'verified',
      source: 'debugging',
      // canonical is never salience-staged, so the corpus size is what was asked
      // for rather than whatever survived the filter.
      memoryClass: 'canonical',
      tags: [`topic=${m.topic}`, `domain=${m.domain}`, 'project=Harborview'],
      enableReinforcement: false,
    } as any);
    const id = res?.engram?.id;
    if (id) { ids.push(id); wrote++; }
    if (wrote % 50 === 0) process.stderr.write(`  ${wrote}/${corpus.length}\n`);
  }

  // --- Deterministic age + usage spread ---
  const db = (store as any).db;
  const stepMs = (SPAN_DAYS * 86400_000) / Math.max(ids.length - 1, 1);
  const setAge = db.prepare(
    'UPDATE engrams SET created_at = ?, last_accessed = ?, access_count = ? WHERE id = ?',
  );
  const applyAges = db.transaction((rows: string[]) => {
    rows.forEach((id, i) => {
      const t = new Date(NEWEST - Math.round((rows.length - 1 - i) * stepMs)).toISOString();
      // A small, deterministic reinforcement history: the real store's engrams
      // have been recalled a varying number of times, and base-level activation
      // reads that. Flat zeroes would remove the signal entirely.
      const accesses = i % 7 === 0 ? 0 : (i % 11);
      setAge.run(t, t, accesses, id);
    });
  });
  applyAges(ids);

  // --- Report ---
  const stats = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN stage='active' AND retracted=0 AND superseded_by IS NULL THEN 1 ELSE 0 END) AS retrievable,
           SUM(CASE WHEN LENGTH(content) > 400 THEN 1 ELSE 0 END) AS over400,
           MIN(created_at) AS oldest, MAX(created_at) AS newest
    FROM engrams
  `).get() as Record<string, any>;

  const lens = (db.prepare('SELECT LENGTH(content) AS n FROM engrams ORDER BY n').all() as { n: number }[])
    .map((r) => r.n);
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const byAgent = db.prepare('SELECT agent_id, COUNT(*) AS c FROM engrams GROUP BY agent_id').all();

  store.close?.();

  console.log(`\nwrote ${DB}`);
  console.log(`  engrams            ${stats.total}  (retrievable ${stats.retrievable})`);
  console.log(`  content median     ${median} chars   over 400: ${stats.over400} (${(100 * stats.over400 / Math.max(stats.total, 1)).toFixed(1)}%)`);
  console.log(`  age span           ${String(stats.oldest).slice(0, 10)} .. ${String(stats.newest).slice(0, 10)}`);
  console.log(`  agents             ${JSON.stringify(byAgent)}`);
  console.log(`  seed               ${seed}  (same seed ⇒ same corpus)`);
  console.log(`\nnext:  npm run bench:public`);
}

main().catch((e) => { console.error(e); process.exit(1); });
