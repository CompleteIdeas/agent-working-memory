/**
 * Profile the recall path AS DAILY USE RUNS IT.
 *
 * `runner.ts` passes `internal: true`, which skips `touchEngram`, the Hebbian
 * co-activation buffer and the activation-event insert. Nothing else does:
 * `internal` appears nowhere in `src/hooks/`, `src/mcp.ts` or the adapters, so
 * every real recall — every `memory_recall` and every UserPromptSubmit prime —
 * runs those three stages. They were therefore absent from every latency
 * number this project has ever published.
 *
 * This driver closes that gap. It is not an accuracy harness and deliberately
 * scores nothing: queries come from `activation_events`, the store's own log of
 * real past recalls, for which no ground truth exists. What it measures is
 * where the time goes on the real query distribution with side effects ON.
 *
 *   npm run profile:recall -- --live
 *   npm run profile:recall -- --live --n 300
 *
 * Two deliberate choices:
 *
 * - **Real contexts, not fixture probes.** The fixture is identifier-shaped by
 *   construction. Real prompts are not: 2.1% of 4,000 logged recalls trip the
 *   pronoun branch that loads every active engram, against 0.2% of fixture
 *   probes — a 10x difference in how often that branch is exercised.
 * - **One process, in order.** `getCoActivatedPairs(10_000)` reads a buffer
 *   that grows across a session, so the Hebbian stage can only be shown to
 *   drift by running a long sequence in one process. The aggregator compares
 *   the first 50 calls against the last 50.
 */
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { recallConfigFingerprint } from '../../src/core/recall-config.js';

const SNAP = join(import.meta.dirname, 'snapshot', process.env.REALSTORE_SNAPSHOT ?? 'store.db');
const WORK = join(tmpdir(), `awm-livesprofile-${process.pid}.db`);
const N = Number(process.env.REALSTORE_LIMIT ?? 200);
const K = Number(process.env.REALSTORE_K ?? 3);

async function main() {
  if (!existsSync(SNAP)) {
    console.error(`no snapshot at ${SNAP}`);
    process.exit(1);
  }
  // Always a copy. This driver writes — touch, co-activation and the event log
  // are the point — so pointing it at the snapshot would mutate the artifact
  // every published number is measured against.
  for (const s of ['', '-wal', '-shm']) {
    try { if (existsSync(WORK + s)) unlinkSync(WORK + s); } catch { /* best effort */ }
  }
  copyFileSync(SNAP, WORK);

  const store = new EngramStore(WORK);
  const activation = new ActivationEngine(store);
  const db = (store as any).db;

  let now = Date.now();
  try {
    const row = db.prepare('SELECT MAX(created_at) AS m FROM engrams').get() as { m?: string };
    if (row?.m) now = Date.parse(row.m);
  } catch { /* fall back to the wall clock */ }

  // Real past recalls, oldest-first so the co-activation buffer fills in the
  // order a session would fill it.
  const rows = db.prepare(`
    SELECT context, agent_id FROM activation_events
    WHERE context IS NOT NULL AND LENGTH(context) > 8
    ORDER BY timestamp DESC LIMIT ?
  `).all(N) as { context: string; agent_id: string }[];

  if (rows.length === 0) {
    console.error('no activation_events in this snapshot — the live profile needs a store with a recall log');
    process.exit(1);
  }
  rows.reverse();

  console.log(`\nLIVE RECALL PROFILE · arm=${recallConfigFingerprint()}`);
  console.log(`k=${K} · side effects ON (internal unset, as in memory_recall and the prime hook)`);
  console.log(`${rows.length} real contexts from activation_events · clock pinned to ${new Date(now).toISOString()}\n`);

  let i = 0;
  let empty = 0;
  for (const r of rows) {
    const res = await activation.activate({
      agentId: r.agent_id, context: r.context, limit: K,
      now, asOf: now,
    } as any);
    if (res.length === 0) empty++;
    if (++i % 50 === 0) process.stderr.write(`  ${i}/${rows.length}\n`);
  }

  console.log(`ran ${i} live recalls · ${empty} returned nothing (abstention or no match)`);
  store.close?.();
  for (const s of ['', '-wal', '-shm']) {
    try { if (existsSync(WORK + s)) unlinkSync(WORK + s); } catch { /* best effort */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
