/**
 * Public retrieval benchmark — the one a stranger can run.
 *
 * `npm run bench` measures against snapshot/store.db, a frozen copy of a real
 * 30k-memory work store. That corpus is private and will stay private, so it is
 * gitignored along with everything derived from it. Which left an honest gap:
 * the repository claimed reproducibility it could not offer to anyone outside.
 *
 * This closes it. Same runner, same ground-truth derivation, same scoring —
 * against a synthetic corpus built from a seeded generator that anyone can
 * rebuild byte-for-byte.
 *
 *   npm run bench:public:build     # once, ~70s — builds snapshot/public-store.db
 *   npm run bench:public           # derive truth + score
 *
 * READ THIS BEFORE QUOTING ANY NUMBER IT PRINTS
 * ---------------------------------------------
 * These are NOT the numbers in docs/benchmarks-current.md and they are not
 * comparable to them. A synthetic corpus has no real supersession history, no
 * months of accumulated co-recall edges, and none of the human inconsistency
 * that makes real retrieval hard. Expect this to score HIGHER than the real
 * store, because it is an easier corpus.
 *
 * What it is actually good for:
 *   1. verifying the METHOD — the hold-out, the abstention accounting, the
 *      sufficiency check — without needing anyone's private data;
 *   2. a stable public baseline, so a retrieval change can be shown to move a
 *      number that a reviewer can reproduce on their own machine.
 *
 * Use the delta. Do not use the absolute.
 *
 * AND MIND THE NOISE FLOOR, MEASURED
 * ----------------------------------
 * Two full builds, 400 probes each, identical code and flags, differing
 * only in corpus seed:
 *
 *            seed 20261008   seed 99
 *   s@1          56.3%        52.0%
 *   s@5          62.0%        58.5%
 *   MRR          58.9%        54.8%
 *   beyond-400   81.3%        81.5%     <- corpus SHAPE is stable
 *   visible n       75           74
 *   silence       100%         100%
 *   sufficiency   100%         100%
 *
 * The corpus reproduces in shape to a fifth of a point and every
 * qualitative result holds across draws — but absolute s@1 moves about
 * FOUR POINTS between seeds. A 2pp 'improvement' on one seed is noise.
 * To claim a retrieval win, move the number on two seeds, or report both.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = join(ROOT, 'tests', 'realstore-eval', 'snapshot', 'public-store.db');

/** The recommended retrieval configuration — what `awm setup` installs. */
const FLAGS = { AWM_RERANK2: '1', AWM_RERANK_WINDOW: 'query', AWM_RERANK_TAGS: '1' };

/** One env set drives both the ground-truth builder and the runner. */
const PUBLIC = {
  REALSTORE_SNAPSHOT: 'public-store.db',
  REALSTORE_FIXTURE: 'fixture-public.json',
  REALSTORE_AGENTS: 'work,personal',
};

function run(label, cmd, args, env) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 64 - label.length))}`);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error(`\n${label} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(SNAP)) {
  console.error('No public snapshot yet.\n');
  console.error('  Build it first:  npm run bench:public:build');
  console.error('\nIt takes about 70 seconds and writes tests/realstore-eval/snapshot/public-store.db.');
  process.exit(1);
}

console.log('PUBLIC retrieval benchmark — synthetic corpus, reproducible from this repository.');
console.log('These numbers are NOT docs/benchmarks-current.md and are not comparable to it.');
console.log('It scores LOWER, not higher — generated prose is more self-similar, so same-domain');
console.log('neighbours are harder to separate. Use the DELTA, not the absolute.');

run('deriving ground truth (same hold-out as the private snapshot)',
  'node', ['tests/realstore-eval/build-fixture.mjs'], PUBLIC);

run('scoring (same runner as the private snapshot)',
  'npx', ['tsx', 'tests/realstore-eval/runner.ts'], { ...FLAGS, ...PUBLIC });

console.log('\nSeed noise on this corpus is about 4pp of s@1 (measured: 56.3% on seed 20261008,');
console.log('52.0% on seed 99). A 2pp move is NOT a result — confirm it on a second seed,');
console.log('built into its own snapshot so the committed one survives:');
console.log('  PUBLIC_CORPUS_SEED=99 REALSTORE_SNAPSHOT=public-store-seed99.db npm run bench:public:build');
console.log('  REALSTORE_SNAPSHOT=public-store-seed99.db REALSTORE_FIXTURE=fixture-public-seed99.json npm run bench:public');
