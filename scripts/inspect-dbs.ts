/**
 * One-off: inspect both memory.db (sqlite) and memory-pglite (pglite) to see
 * which has more recent + more numerous engrams. Used to decide whether
 * pglite → sqlite conversion is needed before switching MCP backends.
 *
 * Run: npx tsx scripts/inspect-dbs.ts
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

async function main() {
  const root = resolve(import.meta.dirname, '..');
  const sqlitePath = resolve(root, 'memory.db');
  const pglitePath = resolve(root, 'memory-pglite');

  // ─── SQLite ────────────────────────────────────────────────────────
  if (existsSync(sqlitePath)) {
    const { EngramStore } = await import('../src/storage/sqlite.js');
    const store = new EngramStore(sqlitePath);
    const db = store.getDb();
    const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM engrams) AS engrams_total,
      (SELECT COUNT(*) FROM engrams WHERE stage = 'active') AS engrams_active,
      (SELECT COUNT(*) FROM associations) AS associations,
      (SELECT MAX(created_at) FROM engrams) AS newest_engram`).get() as any;
    const agents = db.prepare(`SELECT agent_id, COUNT(*) AS n FROM engrams GROUP BY agent_id ORDER BY n DESC LIMIT 5`).all() as any[];
    console.log('--- SQLite (' + sqlitePath + ') ---');
    console.log('  engrams total:    ' + counts.engrams_total);
    console.log('  engrams active:   ' + counts.engrams_active);
    console.log('  associations:     ' + counts.associations);
    console.log('  newest engram:    ' + counts.newest_engram);
    console.log('  top agents:');
    for (const a of agents) console.log('    ' + a.agent_id + ': ' + a.n);
    store.close();
  } else {
    console.log('--- SQLite: file not found ---');
  }

  console.log();

  // ─── PGlite ────────────────────────────────────────────────────────
  if (existsSync(pglitePath)) {
    const { PGliteEngramStore } = await import('../src/storage/pglite.js');
    const store = new PGliteEngramStore(pglitePath);
    await store.ready();
    const db = (store as any).db; // private field — one-off inspection script
    const engramsTotal = await db.query('SELECT COUNT(*) AS c FROM engrams');
    const engramsActive = await db.query("SELECT COUNT(*) AS c FROM engrams WHERE stage = 'active'");
    const associations = await db.query('SELECT COUNT(*) AS c FROM associations');
    const newest = await db.query('SELECT MAX(created_at) AS m FROM engrams');
    const agents = await db.query('SELECT agent_id, COUNT(*) AS n FROM engrams GROUP BY agent_id ORDER BY n DESC LIMIT 5');
    console.log('--- PGlite (' + pglitePath + ') ---');
    console.log('  engrams total:    ' + engramsTotal.rows[0].c);
    console.log('  engrams active:   ' + engramsActive.rows[0].c);
    console.log('  associations:     ' + associations.rows[0].c);
    console.log('  newest engram:    ' + newest.rows[0].m);
    console.log('  top agents:');
    for (const a of agents.rows) console.log('    ' + a.agent_id + ': ' + a.n);
    await store.close();
  } else {
    console.log('--- PGlite: dir not found ---');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
