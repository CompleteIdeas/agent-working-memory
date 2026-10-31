/**
 * Recent decisions (plan 0.22 §4.8 guard; Robert, 2026-10-31: "it's decisions that are made
 * throughout that are important to bring back in real time"). Does recall bring back a decision
 * ahead of the older memories on the same project and topic?
 *
 * Fixture, built from the frozen snapshot: every current memory tagged intent=decision that has at
 * least two OLDER current memories sharing a proj= and a topic= tag with it. The question is one of
 * the decision's generated natural questions (tests/realstore-eval/nl-wq.json — written from that
 * memory alone, without seeing its neighbours). Scored on the snapshot WITHOUT questions indexed,
 * so the question's own wording gives the decision no index advantage.
 *
 * Reports: decision first; decision in top 3; when it is not first, whether an older related
 * memory took its place (the failure Robert cares about) or something else did.
 *
 *   npx tsx tests/realstore-eval/decisions-eval.ts      (writes fixture-decisions.json, gitignored)
 */
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';

const dir = import.meta.dirname;
const WQ = JSON.parse(readFileSync(join(dir, 'nl-wq.json'), 'utf8')) as { questions: Record<string, string[]> };
const db = new Database(join(dir, 'snapshot', 'store.db'), { readonly: true });
const current = `stage = 'active' AND retracted = 0 AND superseded_by IS NULL`;
const tagsOf = (t: string | null) => { try { return JSON.parse(t ?? '[]') as string[]; } catch { return []; } };

type Item = { query: string; goldId: string; agent: string; olderIds: string[]; createdAt: string };
const items: Item[] = [];
let x = 20261031;
const pick = <T,>(xs: T[]) => { x = (x * 1664525 + 1013904223) >>> 0; return xs[x % xs.length]!; };
for (const d of db.prepare(`SELECT id, agent_id, tags, created_at FROM engrams WHERE ${current} AND tags LIKE '%"intent=decision"%' ORDER BY id`).all() as any[]) {
  const tags = tagsOf(d.tags);
  const projs = tags.filter((t) => t.startsWith('proj=')), topics = tags.filter((t) => t.startsWith('topic='));
  const older = new Set<string>();
  for (const p of projs) for (const tp of topics) {
    for (const o of db.prepare(`SELECT id FROM engrams WHERE ${current} AND agent_id = ? AND tags LIKE ? AND tags LIKE ? AND created_at < ? AND id != ?`)
      .all(d.agent_id, `%"${p}"%`, `%"${tp}"%`, d.created_at, d.id) as any[]) older.add(o.id);
  }
  const qs = WQ.questions[d.id];
  if (older.size >= 2 && qs?.length) items.push({ query: pick(qs), goldId: d.id, agent: d.agent_id, olderIds: [...older], createdAt: d.created_at });
}
writeFileSync(join(dir, 'fixture-decisions.json'), JSON.stringify({ note: 'Recent decisions vs older related memories. Built by decisions-eval.ts.', items }, null, 1));

const work = join(tmpdir(), `awm-decisions-${process.pid}.db`);
// DECISIONS_SNAPSHOT=store-wq.db: score with questions indexed — but first remove, from each
// decision, the very question used as its query, so it competes only through its OTHER questions.
const SNAP = process.env.DECISIONS_SNAPSHOT ?? 'store.db';
copyFileSync(join(dir, 'snapshot', SNAP), work);
const store = new EngramStore(work);
if (SNAP !== 'store.db') {
  for (const it of items) {
    const e = store.getEngram(it.goldId);
    if (e?.questions?.length) store.setQuestions(it.goldId, e.questions.filter((q) => q !== it.query));
  }
}
const eng = new ActivationEngine(store as any);
const now = Date.parse('2026-08-24T09:27:21.841Z');
let first = 0, top3 = 0, olderFirst = 0, otherFirst = 0;
const meta = db.prepare('SELECT created_at, tags FROM engrams WHERE id = ?');
let otherNewer = 0, otherOlder = 0, otherDecision = 0;
const misses: Array<{ goldId: string; topId: string; query: string }> = [];
for (const it of items) {
  const res: any[] = await eng.activate({ agentId: it.agent, context: it.query, limit: 3, internal: true, now, asOf: now } as any);
  const idx = res.findIndex((r) => r.engram.id === it.goldId);
  if (idx === 0) first++;
  if (idx >= 0) top3++;
  if (idx !== 0 && res[0]) misses.push({ goldId: it.goldId, topId: res[0].engram.id, query: it.query });
  if (idx !== 0 && res[0]) {
    if (it.olderIds.includes(res[0].engram.id)) olderFirst++;
    else {
      otherFirst++;
      const m: any = meta.get(res[0].engram.id);
      if (m) { if (m.created_at > it.createdAt) otherNewer++; else otherOlder++; if (String(m.tags).includes('"intent=decision"')) otherDecision++; }
    }
  }
}
store.close();
writeFileSync(join(tmpdir(), 'awm-decisions-misses.json'), JSON.stringify(misses));
const n = items.length, pct = (k: number) => `${k} (${(100 * k / n).toFixed(1)}%)`;
console.log(`[${SNAP}] recent-decisions fixture: ${n} decisions, each with >= 2 older related memories (median ${[...items.map((i) => i.olderIds.length)].sort((a, b) => a - b)[Math.floor(n / 2)]})`);
console.log(`  decision first ${pct(first)} · in top 3 ${pct(top3)}`);
console.log(`  when not first: an OLDER related memory took first place ${olderFirst}, something else ${otherFirst}`);
console.log(`  the "something else": newer than the decision ${otherNewer}, older ${otherOlder}; itself a decision ${otherDecision}`);
process.exit(0);
