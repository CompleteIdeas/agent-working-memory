#!/usr/bin/env node
// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Regenerate the CURRENT-VERSION benchmark numbers.  `npm run bench`
 *
 * WHY THIS EXISTS
 * ---------------
 * docs/benchmarks.md accumulated results from five app versions measured by three
 * instruments, two of which were later found defective (a runner at k=7 while the
 * product shipped k=3; ACT-R decay on the wall clock, so a "frozen" snapshot aged a day
 * per day; a runner querying every gold as `work` while a third of them were `personal`).
 * Each defect was corrected in place, so the page became a sediment of superseded numbers
 * that a reader has to date-check by hand.
 *
 * The fix is not to re-run once. It is to make "what this version scores" a GENERATED
 * artifact, stamped with the version, commit and snapshot it came from, so a stale number
 * is impossible rather than merely discouraged. Anything this script cannot regenerate is
 * listed in the output as explicitly historical, not silently carried forward.
 *
 * THREE RULES ENCODED HERE, EACH FROM A REAL FAILURE
 * --------------------------------------------------
 * 1. PREFLIGHT MEMORY. These suites load ONNX models natively; memory that
 *    `--max-old-space-size` does not bound. Five eval runs were OOM-killed on this
 *    machine, one of them mid-write. Refuse to start without headroom.
 * 2. SERIAL, FRESH PROCESS PER SUITE, with a settle gap. Parallel launches are what
 *    caused the kills.
 * 3. STAMP EVERYTHING. Version, commit, dirty flag, snapshot identity and engram counts,
 *    and the exact flags. A number without those is not a measurement, it is a rumour.
 *
 * Usage:
 *   npm run bench                  retrieval fixtures (identifier, category, temporal)
 *   npm run bench -- --all         plus the local challenge suites
 *   npm run bench -- --dry-run     show the plan and the preflight, run nothing
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const OPT = { all: argv.includes('--all'), dryRun: argv.includes('--dry-run') };

const sh = (cmd) => { try { return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

/** Recommended retrieval configuration — what `awm setup` installs, so what we measure. */
const FLAGS = { AWM_RERANK2: '1', AWM_RERANK_WINDOW: 'query', AWM_RERANK_TAGS: '1' };

// ─────────────────────────────────────────────────────────────────────────────
// Rule 1 — preflight
// ─────────────────────────────────────────────────────────────────────────────
const MIN_HEADROOM_GB = Number(process.env.BENCH_MIN_HEADROOM_GB ?? 8);

function commitHeadroomGB() {
  if (process.platform !== 'win32') {
    try {
      const mi = readFileSync('/proc/meminfo', 'utf-8');
      const kb = (k) => Number(mi.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
      return (kb('MemAvailable') + kb('SwapFree')) / 1024 / 1024;
    } catch { return null; }
  }
  const out = sh('powershell -NoProfile -Command "$c=Get-Counter \'\\Memory\\Committed Bytes\',\'\\Memory\\Commit Limit\'; ($c.CounterSamples | ForEach-Object { $_.CookedValue }) -join \',\'"');
  const [committed, limit] = out.split(',').map(Number);
  if (!Number.isFinite(committed) || !Number.isFinite(limit)) return null;
  return (limit - committed) / 1024 ** 3;
}

function preflight() {
  const gb = commitHeadroomGB();
  if (gb === null) {
    console.log('  ~ could not read memory headroom; continuing (set BENCH_MIN_HEADROOM_GB=0 to silence)');
    return true;
  }
  const ok = gb >= MIN_HEADROOM_GB;
  console.log(`  ${ok ? '+' : 'x'} memory headroom: ${gb.toFixed(1)} GB free of commit (need ${MIN_HEADROOM_GB})`);
  if (!ok) {
    console.log('');
    console.log('  These suites load ONNX models natively — memory --max-old-space-size does not bound.');
    console.log('  Five eval runs have been OOM-killed on this machine, one mid-write. Refusing to start.');
    console.log('  Close some memory and re-run, or lower the bar with BENCH_MIN_HEADROOM_GB=<n>.');
  }
  return ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance — what, exactly, produced these numbers
// ─────────────────────────────────────────────────────────────────────────────
async function snapshotFacts() {
  const p = join(ROOT, 'tests/realstore-eval/snapshot/store.db');
  if (!existsSync(p)) return { present: false };
  const facts = { present: true, path: 'tests/realstore-eval/snapshot/store.db', bytes: statSync(p).size };
  try {
    const { default: Database } = await import('better-sqlite3').catch(() => ({ default: null }));
    if (Database) {
      const db = new Database(p, { readonly: true });
      const c = (q) => db.prepare(q).get().c;
      facts.engramsTotal = c('SELECT COUNT(*) c FROM engrams');
      // The retrieval-relevant population: what recall can actually return. This is the
      // number a benchmark denominator should use, and it is ~11.3k where the file holds
      // ~29.9k. Two docs quoted the two figures without saying which; record both.
      facts.engramsRetrievable = c("SELECT COUNT(*) c FROM engrams WHERE stage='active' AND retracted=0 AND superseded_by IS NULL");
      facts.newestCreatedAt = db.prepare('SELECT MAX(created_at) m FROM engrams').get().m;
      db.close();
    }
  } catch { /* counts are a nicety, not a gate */ }
  return facts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suites
// ─────────────────────────────────────────────────────────────────────────────
const RETRIEVAL_SUITES = [
  {
    id: 'identifier',
    title: 'Identifier queries (real store)',
    what: 'Find the memory containing this specific ticket / table / file, 300-query seeded sample',
    cmd: ['npx', 'tsx', 'tests/realstore-eval/runner.ts'],
    env: { ...FLAGS, REALSTORE_LIMIT: '300' },
  },
  {
    id: 'category',
    title: 'Topic queries (real store)',
    what: 'Find the memory about this topic, phrased as a person would, all 450 probes',
    cmd: ['npx', 'tsx', 'tests/realstore-eval/runner.ts'],
    env: { ...FLAGS, REALSTORE_FIXTURE: 'fixture-category.json' },
  },
  {
    id: 'temporal',
    title: 'Temporal cues',
    what: 'Does "last week" / "in March" help, and what a perfect date filter would buy',
    cmd: ['npx', 'tsx', 'tests/realstore-eval/temporal-runner.ts'],
    env: { ...FLAGS },
  },
];

// The four local suites drive a LIVE HTTP server; they do not spin one up. Without it they
// exit 1 in ~10s with "Server not reachable", which the run then reports as FAILED — a
// missing precondition dressed up as a broken product. Probe first and say which it is.
const SERVER_URL = process.env.AWM_TEST_SERVER ?? 'http://localhost:8400';
async function serverUp() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(`${SERVER_URL}/health`, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

const LOCAL_SUITES = [
  { id: 'self', title: 'Self-test (pipeline components)', cmd: ['npm', 'run', 'test:self'], env: {} },
  { id: 'edge', title: 'Edge cases (adversarial failure modes)', cmd: ['npm', 'run', 'test:edge'], env: {} },
  { id: 'stress', title: 'Stress (scale, catastrophic forgetting)', cmd: ['npm', 'run', 'test:stress'], env: {} },
  { id: 'sleep', title: 'Consolidation impact', cmd: ['npm', 'run', 'test:sleep'], env: {} },
];

/** Things this script deliberately cannot regenerate. Listed so gaps stay visible. */
const NOT_REGENERABLE = [
  ['Memory Gauntlet (end-to-end ablation)', 'Lives in the memory-working-agent repo, costs real API spend per arm, and every probe flips between identical runs. Making the probes deterministic is the prerequisite; more reps will not fix it.'],
  ['Production retrieval cost audit', 'Reads local Claude Code transcripts, so it measures one operator\'s usage rather than a property of the release. Re-run deliberately with scripts/measure-claude-vs-awm.ts.'],
  ['LoCoMo', 'Retired in 0.13.x: 115-char passages against a real store\'s ~2,000, one-shot seeding so decay and Hebbian signals contribute nothing, and it rewards indiscriminate retention. Kept only as the record of a tuning decision.'],
];

// ─────────────────────────────────────────────────────────────────────────────
// Parsing — regex over stdout on purpose. Touching the runner to emit JSON would be
// editing the instrument, and this project has been bitten three times by exactly that.
// Raw stdout is archived verbatim, so a parse miss loses a table cell, never the evidence.
// ─────────────────────────────────────────────────────────────────────────────
function parseMetrics(out) {
  const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
  return {
    arm: out.match(/arm=(\S+)/)?.[1] ?? null,
    clockPinned: /clock pinned to (\S+)/.exec(out)?.[1] ?? null,
    corpusPool: num(/corpus (\d+) engrams/),
    answerable: num(/·\s*(\d+) answerable/),
    s1: num(/success@1\s+([\d.]+)%/),
    s5: num(/success@5\s+([\d.]+)%/),
    mrr: num(/MRR\s+([\d.]+)%/),
    adversarialSilent: num(/adversarial correctly silent:\s+([\d.]+)%/),
    p50ms: num(/p50\s+(\d+)ms/),
    p90ms: num(/p90\s+(\d+)ms/),
    sufficiency: num(/SUFFICIENCY\s+([\d.]+)%/),
    netTokens: num(/NET ([+-]?[\d,]+) tok/)
      ?? (out.match(/NET ([+-]?[\d,]+) tok/) ? Number(out.match(/NET ([+-]?[\d,]+) tok/)[1].replace(/,/g, '')) : null),
  };
}

function run(suite, artifactsDir) {
  process.stdout.write(`  running ${suite.id} … `);
  const started = Date.now();
  const r = spawnSync(suite.cmd[0], suite.cmd.slice(1), {
    cwd: ROOT, encoding: 'utf-8', shell: process.platform === 'win32',
    env: { ...process.env, ...suite.env }, timeout: 45 * 60_000, maxBuffer: 64 * 1024 * 1024,
  });
  const secs = Math.round((Date.now() - started) / 1000);
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  writeFileSync(join(artifactsDir, `${suite.id}.log`), out);
  const ok = r.status === 0;
  console.log(ok ? `ok (${secs}s)` : `FAILED exit ${r.status} (${secs}s) — see artifacts/${suite.id}.log`);
  return { ...suite, ok, secs, metrics: ok ? parseMetrics(out) : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────
function render(meta, results) {
  const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);
  const ms = (v) => (v === null || v === undefined ? '—' : `${v} ms`);
  const L = [];
  L.push('<!-- GENERATED BY `npm run bench` — DO NOT EDIT BY HAND. -->');
  L.push('<!-- Hand-written analysis belongs in benchmarks.md; this file is only what the current build scores. -->');
  L.push('');
  L.push(`# Current benchmark results — v${meta.version}`);
  L.push('');
  L.push(`Generated ${meta.date} from commit \`${meta.commit}\`${meta.dirty ? ' **(working tree dirty — not a releasable measurement)**' : ''}.`);
  L.push('');
  L.push('Every number on this page came from one run of `npm run bench` against the snapshot and');
  L.push('flags named below. Nothing here is carried forward from an earlier version; if a row is');
  L.push('missing, that suite did not run, and the reason is at the bottom.');
  L.push('');
  L.push('## Provenance');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Version | ${meta.version} |`);
  L.push(`| Commit | \`${meta.commit}\`${meta.dirty ? ' (dirty)' : ''} |`);
  L.push(`| Date | ${meta.date} |`);
  L.push(`| Retrieval flags | \`${Object.entries(FLAGS).map(([k, v]) => `${k}=${v}`).join(' ')}\` |`);
  if (meta.snapshot.present) {
    L.push(`| Snapshot | \`${meta.snapshot.path}\` |`);
    if (meta.snapshot.engramsTotal) {
      L.push(`| Engrams in snapshot | **${meta.snapshot.engramsTotal.toLocaleString()}** total · **${meta.snapshot.engramsRetrievable.toLocaleString()}** retrievable (active, not retracted, not superseded) |`);
    }
    if (meta.snapshot.newestCreatedAt) L.push(`| Decay clock pinned to | ${meta.snapshot.newestCreatedAt} |`);
  }
  L.push('');
  L.push('> **Which engram count to quote.** Recall can only ever return the *retrievable*');
  L.push('> population, so that is the honest denominator for a retrieval score. The larger');
  L.push('> total counts staged, retracted and superseded rows the ranker never considers.');
  L.push('> Quote one, say which, and use the same one everywhere.');
  L.push('');
  L.push('## Retrieval');
  L.push('');
  L.push('| Suite | probes | s@1 | s@5 | MRR | abstention | p50 | p90 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of results.filter(r => RETRIEVAL_SUITES.some(s => s.id === r.id))) {
    if (!r.ok) { L.push(`| ${r.title} | — | _run failed_ | | | | | |`); continue; }
    const m = r.metrics;
    L.push(`| ${r.title} | ${m.answerable ?? '—'} | **${pct(m.s1)}** | ${pct(m.s5)} | ${pct(m.mrr)} | ${pct(m.adversarialSilent)} | ${ms(m.p50ms)} | ${ms(m.p90ms)} |`);
  }
  L.push('');
  for (const r of results.filter(r => r.ok && r.metrics?.sufficiency !== null && r.metrics?.sufficiency !== undefined)) {
    L.push(`- **${r.title}** — of the golds retrieved, ${pct(r.metrics.sufficiency)} actually contain the answer${r.metrics.netTokens !== null ? `; net token economics ${r.metrics.netTokens >= 0 ? '+' : ''}${r.metrics.netTokens.toLocaleString()} per recall` : ''}.`);
  }
  const localRan = results.filter(r => LOCAL_SUITES.some(s => s.id === r.id));
  if (localRan.length) {
    L.push('');
    L.push('## Local suites');
    L.push('');
    L.push('| Suite | result |');
    L.push('|---|---|');
    for (const r of localRan) {
      if (r.skipped) { L.push(`| ${r.title} | _skipped_ — ${r.reason} |`); continue; }
      L.push(`| ${r.title} | ${r.ok ? `passed (${r.secs}s)` : `**failed** (exit ${r.ok})`} — see \`${meta.artifactsRel}/${r.id}.log\` |`);
    }
  }
  L.push('');
  L.push('## Not regenerated by this run');
  L.push('');
  for (const [name, why] of NOT_REGENERABLE) L.push(`- **${name}.** ${why}`);
  L.push('');
  L.push('## Reproduce');
  L.push('');
  L.push('```bash');
  L.push('npm run bench             # the retrieval fixtures above');
  L.push('npm run bench -- --all    # plus the local challenge suites');
  L.push('```');
  L.push('');
  L.push(`Raw stdout for every suite is archived under \`${meta.artifactsRel}/\`.`);
  L.push('');
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const suites = [...RETRIEVAL_SUITES, ...(OPT.all ? LOCAL_SUITES : [])];

  console.log(`\nBenchmark run — v${pkg.version}\n`);
  console.log('  plan:');
  for (const s of suites) console.log(`    - ${s.id.padEnd(11)} ${s.what ?? s.title}`);
  console.log('');

  const passed = preflight();
  if (OPT.dryRun) { console.log('\n  --dry-run: nothing executed.\n'); process.exit(passed ? 0 : 1); }
  if (!passed) process.exit(1);

  const date = new Date().toISOString().slice(0, 10);
  const meta = {
    version: pkg.version,
    commit: sh('git rev-parse --short HEAD') || 'unknown',
    dirty: sh('git status --porcelain').split('\n').some(l => l && !/^\?\?/.test(l)),
    date,
    snapshot: await snapshotFacts(),
  };
  const artifactsRel = `bench-runs/${meta.version}-${date}`;
  const artifactsDir = join(ROOT, artifactsRel);
  mkdirSync(artifactsDir, { recursive: true });
  meta.artifactsRel = artifactsRel;

  if (meta.dirty) console.log('  ~ working tree is dirty — fine for a look, not for a published number\n');

  const localIds = new Set(LOCAL_SUITES.map(s => s.id));
  const haveServer = OPT.all ? await serverUp() : true;
  if (OPT.all && !haveServer) {
    console.log(`  ~ no server at ${SERVER_URL} — the four local suites need one and will be SKIPPED.`);
    console.log('    start one with:  AWM_DB_PATH=<scratch>.db npm start');
    console.log('');
  }

  const results = [];
  for (const s of suites) {
    if (localIds.has(s.id) && !haveServer) {
      console.log(`  running ${s.id} … skipped (no server at ${SERVER_URL})`);
      results.push({ ...s, ok: false, skipped: true, reason: `needs a live server at ${SERVER_URL}`, secs: 0, metrics: null });
      continue;
    }
    results.push(run(s, artifactsDir));
    await new Promise(r => setTimeout(r, 8000));   // settle: let the ONNX heap actually go back
  }

  writeFileSync(join(artifactsDir, 'results.json'), JSON.stringify({ meta, results }, null, 2) + '\n');
  const md = render(meta, results);
  writeFileSync(join(ROOT, 'docs/benchmarks-current.md'), md);

  const failed = results.filter(r => !r.ok && !r.skipped);
  console.log(`\n  wrote docs/benchmarks-current.md and ${artifactsRel}/results.json`);
  const skipped = results.filter(r => r.skipped);
  if (skipped.length) console.log(`  ${skipped.length} suite(s) SKIPPED — precondition missing, not a failure`);
  console.log(failed.length ? `  ${failed.length} suite(s) FAILED — the page marks them rather than omitting them\n` : '  all suites completed\n');
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
