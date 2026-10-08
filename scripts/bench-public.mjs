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
console.log('A synthetic corpus is easier than a real one; use the DELTA, not the absolute.');

run('deriving ground truth (same hold-out as the private snapshot)',
  'node', ['tests/realstore-eval/build-fixture.mjs'], PUBLIC);

run('scoring (same runner as the private snapshot)',
  'npx', ['tsx', 'tests/realstore-eval/runner.ts'], { ...FLAGS, ...PUBLIC });

console.log('\nDone. Rebuild the corpus with a different seed to check you are not fitting one draw:');
console.log('  PUBLIC_CORPUS_SEED=99 npm run bench:public:build && npm run bench:public');
