/**
 * Compare fetch strategies: full vs slim+hydrate on the same DB.
 */
import { EngramStore } from '../src/storage/sqlite.js';

const dbPath = process.env.AWM_DB_PATH ?? 'memory.db';
const agentId = process.env.AWM_AGENT_ID ?? 'work';
const store = new EngramStore(dbPath);

function ms(start: bigint): number { return Number(process.hrtime.bigint() - start) / 1e6; }

console.log(`db=${dbPath} agent=${agentId}\n`);

// Warm both cache paths
store.getEngramsByAgent(agentId, 'active');
store.getEngramsByAgentSlim(agentId, 'active'); // populates slim cache

// Full fetch
const fullTimes: number[] = [];
for (let i = 0; i < 5; i++) {
  const t = process.hrtime.bigint();
  const all = store.getEngramsByAgent(agentId, 'active');
  fullTimes.push(ms(t));
  if (i === 0) console.log(`  full fetch (SELECT * x ${all.length}): ${fullTimes[0].toFixed(0)}ms`);
}
console.log(`  full fetch avg over 5: ${(fullTimes.reduce((a, b) => a + b, 0) / 5).toFixed(0)}ms`);

// Slim fetch
const slimTimes: number[] = [];
for (let i = 0; i < 5; i++) {
  const t = process.hrtime.bigint();
  const all = store.getEngramsByAgentSlim(agentId, 'active');
  slimTimes.push(ms(t));
  if (i === 0) console.log(`  slim fetch (SELECT id,concept,embedding x ${all.length}): ${slimTimes[0].toFixed(0)}ms`);
}
console.log(`  slim fetch avg over 5: ${(slimTimes.reduce((a, b) => a + b, 0) / 5).toFixed(0)}ms`);

// Hydrate sample of 200
const all = store.getEngramsByAgentSlim(agentId, 'active');
const sample200 = all.slice(0, 200).map(e => e.id);
const hydrateTimes: number[] = [];
for (let i = 0; i < 5; i++) {
  const t = process.hrtime.bigint();
  const hydrated = store.getEngramsByIds(sample200);
  hydrateTimes.push(ms(t));
  if (i === 0) console.log(`  hydrate by IDs (200 rows): ${hydrateTimes[0].toFixed(0)}ms (got ${hydrated.length})`);
}
console.log(`  hydrate 200 avg over 5: ${(hydrateTimes.reduce((a, b) => a + b, 0) / 5).toFixed(0)}ms`);

console.log();
console.log(`Two-pass total (slim + hydrate-200): ${((slimTimes.reduce((a, b) => a + b, 0) + hydrateTimes.reduce((a, b) => a + b, 0)) / 5).toFixed(0)}ms avg`);
console.log(`Single-pass full fetch:              ${(fullTimes.reduce((a, b) => a + b, 0) / 5).toFixed(0)}ms avg`);
console.log(`Delta (positive = faster two-pass):  ${((fullTimes.reduce((a, b) => a + b, 0) - slimTimes.reduce((a, b) => a + b, 0) - hydrateTimes.reduce((a, b) => a + b, 0)) / 5).toFixed(0)}ms`);

store.close();
