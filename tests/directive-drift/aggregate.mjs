/**
 * Assemble one cross-arm table from several single-arm P-0 runs.
 *
 * Run 2 launched each arm as its own process so the three could run in parallel —
 * 130 turns x 2 trials sequentially in one process is about two hours. The cost is
 * that each process prints only its own arm, so the comparison has to be reassembled.
 *
 * Parses the per-bucket progress lines, which are the most stable thing in the output:
 *   "  A0-stated-once trial 1  turns 51-60: 38/42 obligations met"
 * plus the first-failure block and the context-size line from the final report.
 *
 * Usage: node tests/directive-drift/aggregate.mjs <file-or-dir> [...]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node aggregate.mjs <output-file-or-dir> [...]');
  process.exit(1);
}

const files = [];
for (const a of args) {
  if (statSync(a).isDirectory()) {
    for (const f of readdirSync(a)) if (f.endsWith('.output')) files.push(join(a, f));
  } else files.push(a);
}

const PROGRESS = /^\s*(\S+)\s+trial\s+(\d+)\s+turns\s+(\d+)-(\d+):\s+(\d+)\/(\d+)\s+obligations met/;
const HEADER = /^P-0 directive drift — model=(\S+) turns=(\d+) trials=(\d+)/;
const FIRSTFAIL = /^\s{2}(suffix|confidence|us-spelling|brevity|next-step)\s+(.+)$/;
const CONTEXT = /peak input\s+(\d+) tokens, last turn (\d+)/;

/** key: `${model}|${arm}` */
const runs = new Map();

for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  const h = text.split('\n').map(l => HEADER.exec(l)).find(Boolean);
  if (!h) continue;                               // not one of our runs
  const model = h[1];
  let inFirstFail = false;
  let currentArm = null;

  for (const line of text.split('\n')) {
    const p = PROGRESS.exec(line);
    if (p) {
      const [, arm, trial, from, to, met, total] = p;
      const key = `${model}|${arm}`;
      if (!runs.has(key)) runs.set(key, { model, arm, buckets: new Map(), firstFail: {}, peak: 0, lastTurn: 0 });
      const r = runs.get(key);
      const b = `${from}-${to}`;
      const prev = r.buckets.get(b) ?? [0, 0];
      r.buckets.set(b, [prev[0] + Number(met), prev[1] + Number(total)]);
      currentArm = arm;
      continue;
    }
    if (line.startsWith('=== first failure')) { inFirstFail = true; continue; }
    if (line.startsWith('=== context size')) { inFirstFail = false; continue; }
    if (/^[A-Z]\d-/.test(line.trim()) && !line.includes('trial')) currentArm = line.trim();
    if (inFirstFail && currentArm) {
      const ff = FIRSTFAIL.exec(line);
      if (ff) {
        const key = `${model}|${currentArm}`;
        if (runs.has(key)) runs.get(key).firstFail[ff[1]] = ff[2].trim();
      }
    }
    const c = CONTEXT.exec(line);
    if (c && currentArm) {
      const key = `${model}|${currentArm}`;
      if (runs.has(key)) { runs.get(key).peak = Number(c[1]); runs.get(key).lastTurn = Number(c[2]); }
    }
  }
}

if (!runs.size) { console.error('no P-0 runs found in those files'); process.exit(1); }

const models = [...new Set([...runs.values()].map(r => r.model))];
for (const model of models) {
  const rows = [...runs.values()].filter(r => r.model === model).sort((a, b) => a.arm.localeCompare(b.arm));
  // Bucket labels in numeric order of their start turn.
  const labels = [...new Set(rows.flatMap(r => [...r.buckets.keys()]))]
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));

  console.log(`\n================ ${model} ================`);
  console.log('arm'.padEnd(20) + labels.map(l => l.padStart(9)).join(''));
  for (const r of rows) {
    const cells = labels.map(l => {
      const v = r.buckets.get(l);
      return (v && v[1] ? `${(100 * v[0] / v[1]).toFixed(0)}%` : '·').padStart(9);
    }).join('');
    console.log(r.arm.padEnd(20) + cells);
  }

  // Pooled first vs second half — the only comparison that speaks to decay.
  console.log('\nfirst half vs second half (pooled over trials):');
  for (const r of rows) {
    const mid = labels.length / 2;
    let a = [0, 0], b = [0, 0];
    labels.forEach((l, i) => {
      const v = r.buckets.get(l); if (!v) return;
      const t = i < mid ? a : b;
      t[0] += v[0]; t[1] += v[1];
    });
    const pa = a[1] ? 100 * a[0] / a[1] : NaN, pb = b[1] ? 100 * b[0] / b[1] : NaN;
    const delta = pb - pa;
    console.log(`  ${r.arm.padEnd(20)} ${pa.toFixed(1)}%  ->  ${pb.toFixed(1)}%   ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp`
      + `   peak context ${r.peak || '?'} tok, last turn ${r.lastTurn || '?'}`);
  }

  console.log('\nfirst failure per directive:');
  for (const r of rows) {
    console.log(`  ${r.arm}`);
    for (const [rule, val] of Object.entries(r.firstFail)) {
      console.log(`    ${rule.padEnd(14)} ${val}`);
    }
  }
}
