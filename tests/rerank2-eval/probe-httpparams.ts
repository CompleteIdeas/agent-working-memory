/**
 * Why did the HTTP benchmark show no effect from phase 9b when the tracer showed +9.7pp?
 * Replicate the benchmark's EXACT activate params in-process and compare flag off vs on.
 * The suspect is includeStaging:true, which the tracer never set.
 */
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';

const DB = join(import.meta.dirname, '..', '..', 'data', '_probe.db');
const DATA = join(import.meta.dirname, '..', 'locomo-eval', 'data', 'locomo10.json');

async function main() {
  for (const e of ['', '-wal', '-shm']) { try { if (existsSync(DB + e)) unlinkSync(DB + e); } catch {} }
  const data = JSON.parse(readFileSync(DATA, 'utf8'));
  const store = new EngramStore(DB);
  const activation = new ActivationEngine(store);
  const connections = new ConnectionEngine(store, activation);
  const rec = data[0], agentId = 'probe';
  const dia = new Map<string, string>();

  for (let s = 1; s <= 9; s++) {
    for (const t of (rec.conversation[`session_${s}`] ?? [])) {
      if (!t.text || t.text.trim().length < 10) continue;
      const r: any = await performWrite({ store, connectionEngine: connections } as any, {
        agentId, concept: `${t.speaker} ${t.text.split(/\s+/).slice(0, 6).join(' ')}`,
        content: t.text, tags: [t.dia_id],
      } as any);
      if (r?.engram?.id) dia.set(t.dia_id, r.engram.id);
    }
  }

  const qs = (rec.qa ?? []).filter((q: any) => q.category !== 5).slice(0, 60);
  for (const includeStaging of [false, true]) {
    let differ = 0, eligible = 0, n = 0;
    for (const qa of qs) {
      const p: any = { agentId, context: qa.question, limit: 10, includeStaging, useReranker: true, internal: true };
      delete process.env.AWM_RERANK2;
      const off = await activation.activate(p);
      process.env.AWM_RERANK2 = '1';
      const on = await activation.activate(p);
      delete process.env.AWM_RERANK2;
      if (!off.length) continue;
      n++;
      if (off.slice(0, 10).every((r: any) => (r.phaseScores?.rerankerScore ?? 0) > 0)) eligible++;
      const a = off.map((r: any) => r.engram.id).join(','), b = on.map((r: any) => r.engram.id).join(',');
      if (a !== b) differ++;
    }
    console.log(`includeStaging=${String(includeStaging).padEnd(5)}  queries=${n}  ` +
                `phase9b-eligible=${eligible} (${(100 * eligible / Math.max(n,1)).toFixed(0)}%)  ` +
                `ORDER CHANGED by flag=${differ} (${(100 * differ / Math.max(n,1)).toFixed(0)}%)`);
  }
  store.close?.();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
