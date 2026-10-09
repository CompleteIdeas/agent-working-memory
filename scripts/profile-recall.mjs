/**
 * Stage-level recall profile — where a recall's milliseconds actually go.
 *
 * The write path has had phase telemetry since D1. The read path had one
 * number: the total. So every statement in this repository about WHICH stage
 * owns that total was a reading of the code, not a measurement — including the
 * comment in `tests/realstore-eval/runner.ts` asserting the cross-encoder is
 * "~90% of warm recall latency", which cites only an identical comment in
 * `src/engine/activation.ts`. This script exists so that figure can be checked.
 *
 *   npm run profile:recall                    # private snapshot, 120 probes
 *   npm run profile:recall -- --n 300
 *   npm run profile:recall -- --public        # reproducible corpus
 *   npm run profile:recall -- --jsonl FILE    # re-aggregate an existing capture
 *
 * WHAT IT MEASURES
 * ----------------
 * `src/core/recall-telemetry.ts` records one record per `activate()` call with
 * a flat, non-overlapping span per stage. Flat and non-overlapping is what
 * makes `unaccounted` meaningful: it is the synchronous JavaScript that no
 * stage claims, so if it is large, that is itself the finding.
 *
 * TWO THINGS THAT WILL MISLEAD YOU IF YOU SKIP THEM
 * -------------------------------------------------
 * 1. **Warm-up.** The first recall pays the cross-encoder's ONNX cold load.
 *    The first `--warmup` records (default 10) are reported separately and
 *    excluded from the percentiles, because mixing them in inflates every
 *    stage share by a one-off cost no steady-state caller pays.
 * 2. **`internal: true`.** The benchmark runner sets it, which skips
 *    `touchEngram`, the Hebbian co-activation buffer and the activation-event
 *    insert. Those all run in daily use, on every prompt via the
 *    UserPromptSubmit prime hook. So the default profile here measures the
 *    benchmark's path; `--live` measures the path Robert actually feels.
 *
 * Latency on this machine is monotonic in available memory and accuracy is
 * not (measured: 1118 -> 1010 -> 712ms as RAM freed, identical accuracy), so
 * read the SHARES, which survive load noise, before the absolute times.
 */
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const N = Number(arg('n', 120));
const WARMUP = Number(arg('warmup', 10));
const PUBLIC = has('public');
const LIVE = has('live');
const SNAPSHOT = arg('snapshot', PUBLIC ? 'public-store.db' : 'store.db');
const FIXTURE = arg('fixture', PUBLIC ? 'fixture-public.json' : 'fixture.json');
const K = arg('k', '3');

/** The recommended retrieval configuration — what `awm setup` installs. */
const FLAGS = { AWM_RERANK2: '1', AWM_RERANK_WINDOW: 'query', AWM_RERANK_TAGS: '1' };

// Lever pass-throughs, so a sweep is one command per arm and the arm is recorded
// in the banner rather than in someone's shell history.
const LEVERS = {};
for (const [flag, env] of [['pool', 'AWM_RERANK_POOL'], ['dtype', 'AWM_RERANKER_DTYPE'],
  ['trunc', 'AWM_RERANK_TRUNC'], ['tagslen', 'AWM_RERANK_TAGS_LEN']]) {
  const v = arg(flag, null);
  if (v !== null) LEVERS[env] = v;
}
if (has('no-skip-guard')) LEVERS.AWM_RERANK_SKIP_POOL = 'off';

const OUT = arg('jsonl', join(tmpdir(), `awm-recall-profile-${process.pid}.jsonl`));

// ---------- capture ----------

if (!has('jsonl')) {
  const snapPath = join(ROOT, 'tests', 'realstore-eval', 'snapshot', SNAPSHOT);
  if (!existsSync(snapPath)) {
    console.error(`No snapshot at ${snapPath}.`);
    console.error(PUBLIC ? '  Build it:  npm run bench:public:build' : '  The private snapshot is maintainer-only; try --public.');
    process.exit(1);
  }
  try { if (existsSync(OUT)) unlinkSync(OUT); } catch { /* best effort */ }
  try { mkdirSync(dirname(OUT), { recursive: true }); } catch { /* best effort */ }

  const env = {
    ...process.env,
    ...FLAGS,
    ...LEVERS,
    REALSTORE_SNAPSHOT: SNAPSHOT,
    REALSTORE_FIXTURE: FIXTURE,
    REALSTORE_LIMIT: String(N),
    REALSTORE_K: K,
    AWM_PROFILE_RECALL_OUT: OUT,
    // The trace is this script's own byproduct; keep it out of the repo so a
    // profiling run never dirties the tree the release gate checks.
    REALSTORE_TRACE: join(tmpdir(), `awm-recall-profile-trace-${process.pid}.jsonl`),
  };

  const target = LIVE
    ? ['tsx', 'tests/realstore-eval/profile-live.ts']
    : ['tsx', 'tests/realstore-eval/runner.ts'];

  console.log(`capturing ${N} recalls · snapshot ${SNAPSHOT} · k=${K} · ${LIVE ? 'LIVE path (side effects ON)' : 'benchmark path (internal:true)'}`);
  const r = spawnSync('npx', target, {
    cwd: ROOT, stdio: 'inherit', env, shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error(`\ncapture failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}

// ---------- aggregate ----------

if (!existsSync(OUT)) {
  console.error(`No profile records at ${OUT} — is the instrumentation present in activate()?`);
  process.exit(1);
}

const all = readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (all.length === 0) { console.error('No records captured.'); process.exit(1); }

const cold = all.slice(0, Math.min(WARMUP, all.length));
const warm = all.slice(Math.min(WARMUP, all.length));
if (warm.length === 0) {
  console.error(`Only ${all.length} records; all inside the ${WARMUP}-call warm-up. Raise --n.`);
  process.exit(1);
}

const pct = (xs, p) => {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
};
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

const labels = new Set();
for (const r of warm) for (const k of Object.keys(r.stages ?? {})) labels.add(k);

const totals = warm.map((r) => r.totalMs);
const rows = [...labels].map((label) => {
  const xs = warm.map((r) => r.stages?.[label] ?? 0);
  const ran = warm.filter((r) => (r.stages?.[label] ?? 0) > 0).length;
  return {
    label,
    mean: mean(xs),
    p50: pct(xs, 50),
    p95: pct(xs, 95),
    share: (100 * mean(xs)) / mean(totals),
    ran: (100 * ran) / warm.length,
  };
}).sort((a, b) => b.mean - a.mean);

const unacc = warm.map((r) => r.unaccountedMs ?? 0);
rows.push({
  label: '(unaccounted JS)', mean: mean(unacc), p50: pct(unacc, 50), p95: pct(unacc, 95),
  share: (100 * mean(unacc)) / mean(totals), ran: 100,
});

const fmt = (n, w = 7) => n.toFixed(1).padStart(w);
console.log(`\n── recall stage profile ${'─'.repeat(50)}`);
console.log(`snapshot ${SNAPSHOT} · fixture ${FIXTURE} · k=${K} · path ${LIVE ? 'LIVE' : 'internal'}`);
console.log(`${warm.length} warm recalls (first ${cold.length} discarded as warm-up)`);
const leverStr = Object.entries(LEVERS).map(([k, v]) => `${k}=${v}`).join(' ');
console.log(`arm AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1${leverStr ? ' · ' + leverStr : ' · defaults'}\n`);

console.log('stage                  mean     p50     p95    share   ran%');
console.log('─'.repeat(63));
for (const r of rows) {
  if (r.mean < 0.05 && r.label !== '(unaccounted JS)') continue;
  console.log(`${r.label.padEnd(20)}${fmt(r.mean)}${fmt(r.p50)}${fmt(r.p95)}${fmt(r.share, 8)}%${fmt(r.ran, 7)}`);
}
console.log('─'.repeat(63));
console.log(`${'TOTAL'.padEnd(20)}${fmt(mean(totals))}${fmt(pct(totals, 50))}${fmt(pct(totals, 95))}`);

if (cold.length) {
  console.log(`\ncold start: first recall ${Math.round(cold[0].totalMs)}ms` +
    (cold[0].stages?.rerank ? ` (rerank ${Math.round(cold[0].stages.rerank)}ms of it)` : '') +
    ` · warm p50 ${Math.round(pct(totals, 50))}ms`);
}

// ---------- shape of the work ----------

const noteStat = (key) => {
  const xs = warm.map((r) => r[key]).filter((v) => typeof v === 'number');
  return xs.length ? `${pct(xs, 50)} (p95 ${pct(xs, 95)})` : 'n/a';
};
console.log('\nwork shape (median):');
console.log(`  candidates scored        ${noteStat('candidates')}`);
console.log(`  rerank pool              ${noteStat('rerankPool')}`);
console.log(`  passage chars (pool sum) ${noteStat('passageChars')}`);
console.log(`  longest passage          ${noteStat('passageMaxChars')}`);
const skipped = warm.filter((r) => r.rerankSkipped === true).length;
console.log(`  rerank skip fired        ${skipped}/${warm.length} (${(100 * skipped / warm.length).toFixed(1)}%)`);
const abstained = warm.filter((r) => r.abstained).length;
console.log(`  abstained                ${abstained}/${warm.length}`);

// Drift: stages backed by a buffer that grows across a session cannot be caught
// by an average. `getCoActivatedPairs(10_000)` is read on every non-internal
// recall, so compare the start of the run against the end.
if (warm.length >= 100) {
  const head = warm.slice(0, 50);
  const tail = warm.slice(-50);
  const drifters = ['hebbian', 'touch', 'logEvent', 'assocStats'];
  const shown = drifters
    .map((label) => ({
      label,
      a: mean(head.map((r) => r.stages?.[label] ?? 0)),
      b: mean(tail.map((r) => r.stages?.[label] ?? 0)),
    }))
    .filter((d) => d.a > 0.05 || d.b > 0.05);
  if (shown.length) {
    console.log('\ndrift across the run (mean ms, first 50 vs last 50):');
    for (const d of shown) {
      const delta = d.a > 0 ? `${((100 * (d.b - d.a)) / d.a).toFixed(0)}%` : 'n/a';
      console.log(`  ${d.label.padEnd(22)} ${d.a.toFixed(2)} -> ${d.b.toFixed(2)}  (${delta})`);
    }
  }
}

console.log(`\nrecords: ${OUT}`);
