// One-off probe: for N identifier-fixture queries, run activate() twice on the same
// snapshot copy — once as shipped, once with graph traversal disabled — and count how
// many top-3 result sets differ. If the answer is ~0, the graph (and with it 129k bridge
// edges) is not moving results, and the reranker is doing the ranking alone.
import { copyFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const SNAP = join(import.meta.dirname, 'snapshot', 'store.db');
const WORK = join(tmpdir(), `awm-graphprobe-${process.pid}.db`);
copyFileSync(SNAP, WORK);
const fx = JSON.parse(readFileSync(join(import.meta.dirname, 'fixture.json'), 'utf8'));
const items = fx.items.slice(0, Number(process.env.PROBE_N ?? 120));

const store = new EngramStore(WORK);
const eng = new ActivationEngine(store);
const ids = (r: any[]) => r.map(x => x.engram.id).join('|');

let differ = 0, top1differ = 0, graphNonZero = 0, n = 0;
for (const it of items) {
  const base = await eng.activate({ agentId: it.agent, context: it.query, limit: 3, internal: true } as any);
  // Disable the graph by the only knob available without code change: zero-weight walk.
  // ActivationEngine.GRAPH_WEIGHTS is private static; mutate via cast for the probe only.
  const GW = (ActivationEngine as any).GRAPH_WEIGHTS;
  const saved = { ...GW };
  for (const k of Object.keys(GW)) GW[k] = 0;
  const nog = await eng.activate({ agentId: it.agent, context: it.query, limit: 3, internal: true } as any);
  Object.assign(GW, saved);
  n++;
  if (ids(base) !== ids(nog)) differ++;
  if (base[0]?.engram.id !== nog[0]?.engram.id) top1differ++;
  if (base.some((r: any) => (r.phaseScores?.graphBoost ?? 0) > 0)) graphNonZero++;
}
console.log(`probed ${n} queries`);
console.log(`  results where ANY graphBoost > 0 in top-3 : ${graphNonZero} (${(100*graphNonZero/n).toFixed(0)}%)`);
console.log(`  top-3 SET differs with graph off          : ${differ} (${(100*differ/n).toFixed(0)}%)`);
console.log(`  top-1 differs with graph off              : ${top1differ} (${(100*top1differ/n).toFixed(0)}%)`);
store.close();
if (existsSync(WORK)) unlinkSync(WORK);
