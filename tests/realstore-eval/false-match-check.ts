import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTemporal } from '../../src/core/temporal-query.js';
const fx = JSON.parse(readFileSync(join(import.meta.dirname, 'fixture.json'), 'utf8'));
const asOf = Date.UTC(2026, 7, 24);
let hits = 0;
for (const it of fx.items) {
  const r = parseTemporal(it.query, asOf);
  if (r) { hits++; if (hits <= 10) console.log(`  FALSE [${r.kind}] matched=${JSON.stringify(r.matched)}  q="${it.query.slice(0, 62)}"`); }
}
console.log(`\n  false temporal matches: ${hits} of ${fx.items.length} identifier queries (${(100 * hits / fx.items.length).toFixed(1)}%)`);
