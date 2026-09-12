import { copyFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
const H = import.meta.dirname;
const rows = readFileSync(join(H, 'miss-stage-pinned-aug24.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.wideRank < 0).slice(0, 4);
const W = join(tmpdir(), `awm-onemiss-${process.pid}.db`); copyFileSync(join(H, 'snapshot', 'store.db'), W);
const store = new EngramStore(W); const eng = new ActivationEngine(store);
const NOW = Date.parse((store as any).db.prepare('SELECT MAX(created_at) m FROM engrams').get().m);
for (const r of rows) {
  const g = (store as any).db.prepare('SELECT concept, LENGTH(content) len, stage, retracted, superseded_by, agent_id FROM engrams WHERE id=?').get(r.goldId);
  const res: any[] = await eng.activate({ agentId: g.agent_id, context: r.query, limit: 50, internal: true, now: NOW, asOf: NOW } as any);
  const idx = res.findIndex(x => x.engram.id === r.goldId);
  console.log(`Q: ${r.query.slice(0, 70)}`);
  console.log(`   gold: stage=${g.stage} retracted=${g.retracted} superseded=${!!g.superseded_by} agent=${g.agent_id} len=${g.len}  -> rank with filter ${process.env.AWM_DISABLE_POOL_FILTER === '1' ? 'DISABLED' : 'on'}: ${idx < 0 ? 'ABSENT' : idx + 1}`);
}
store.close(); for (const s of ['', '-wal', '-shm']) { try { if (existsSync(W + s)) unlinkSync(W + s); } catch {} }
