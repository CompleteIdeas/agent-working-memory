// One-off — inspect the target SQLite db to confirm contents before pointing MCP at it.
import { EngramStore } from '../src/storage/sqlite.js';

const TARGET = 'C:/Users/robert/Personal-Projects/AgentSynapse/packages/awm/memory.db';
const store = new EngramStore(TARGET);
const db = store.getDb();
const counts = db.prepare(`SELECT
  (SELECT COUNT(*) FROM engrams) AS engrams_total,
  (SELECT COUNT(*) FROM engrams WHERE stage = 'active') AS engrams_active,
  (SELECT COUNT(*) FROM engrams WHERE stage = 'staging') AS engrams_staging,
  (SELECT COUNT(*) FROM associations) AS associations,
  (SELECT MAX(created_at) FROM engrams) AS newest_engram`).get() as any;
const agents = db.prepare(`SELECT agent_id, COUNT(*) AS n FROM engrams GROUP BY agent_id ORDER BY n DESC LIMIT 8`).all() as any[];
console.log('Target: ' + TARGET);
console.log('  engrams total:    ' + counts.engrams_total);
console.log('  engrams active:   ' + counts.engrams_active);
console.log('  engrams staging:  ' + counts.engrams_staging);
console.log('  associations:     ' + counts.associations);
console.log('  newest engram:    ' + counts.newest_engram);
console.log('  top agents:');
for (const a of agents) console.log('    ' + a.agent_id + ': ' + a.n);
store.close();
