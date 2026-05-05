#!/usr/bin/env node
// Evict stale low-utility working-class memories.
// Run weekly or monthly as a maintenance job.
//
// Policy: drop a working-class engram only when ALL of these are true:
//   - memory_class = 'working' (canonical/ephemeral skipped — different lifecycle)
//   - salience < SALIENCE_CUTOFF (default 0.30)
//   - access_count < ACCESS_CUTOFF (default 2 — never recalled, or recalled only once)
//   - last_activated older than IDLE_DAYS (default 90)
//   - NOT superseded chain head (preserve history pointers)
//   - agent_id NOT in PROTECTED_AGENTS (claude-code, etc. — anything user-facing)
//
// Use --dry-run to preview without deleting.

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.AWM_DB_PATH || path.join(__dirname, '..', 'memory.db');
const SALIENCE_CUTOFF = Number(process.env.AWM_EVICT_SALIENCE || 0.30);
const ACCESS_CUTOFF = Number(process.env.AWM_EVICT_ACCESS || 2);
const IDLE_DAYS = Number(process.env.AWM_EVICT_IDLE_DAYS || 90);
const DRY_RUN = process.argv.includes('--dry-run');
const PROTECTED_AGENTS = (process.env.AWM_PROTECTED_AGENTS || 'claude-code')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

console.log(`DB: ${DB_PATH}`);
console.log(`Cutoffs: salience<${SALIENCE_CUTOFF}, access<${ACCESS_CUTOFF}, idle>${IDLE_DAYS}d`);
console.log(`Protected agents: ${PROTECTED_AGENTS.join(', ') || '(none)'}`);
console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`);

const db = new Database(DB_PATH);

const protectedClause = PROTECTED_AGENTS.length
  ? `AND agent_id NOT IN (${PROTECTED_AGENTS.map(() => '?').join(',')})`
  : '';

const candidateSql = `
  SELECT id FROM engrams
  WHERE memory_class = 'working'
    AND salience < ?
    AND COALESCE(access_count, 0) < ?
    AND julianday('now') - julianday(last_accessed) > ?
    AND superseded_by IS NULL
    ${protectedClause}
`;

const params = [SALIENCE_CUTOFF, ACCESS_CUTOFF, IDLE_DAYS, ...PROTECTED_AGENTS];

const candidates = db.prepare(candidateSql).all(...params);
console.log(`Eviction candidates: ${candidates.length}`);

if (candidates.length === 0) {
  console.log('Nothing to evict.');
  db.close();
  process.exit(0);
}

if (DRY_RUN) {
  const preview = db.prepare(`
    SELECT agent_id, COUNT(*) AS cnt, ROUND(AVG(salience), 2) AS avg_sal
    FROM engrams
    WHERE id IN (${candidates.map(() => '?').join(',')})
    GROUP BY agent_id
    ORDER BY cnt DESC
    LIMIT 20
  `).all(...candidates.map(c => c.id));
  console.log('Top affected agents:');
  preview.forEach(r => console.log(`  ${r.agent_id}: ${r.cnt} (avg salience ${r.avg_sal})`));
  db.close();
  process.exit(0);
}

const t0 = Date.now();
const evict = db.transaction(() => {
  db.exec(`CREATE TEMP TABLE evict_ids AS SELECT id FROM engrams WHERE 0`);
  const insertId = db.prepare('INSERT INTO evict_ids(id) VALUES (?)');
  for (const row of candidates) insertId.run(row.id);

  const aRes = db.prepare(`
    DELETE FROM associations
    WHERE from_engram_id IN (SELECT id FROM evict_ids)
       OR to_engram_id IN (SELECT id FROM evict_ids)
  `).run();
  console.log(`  associations removed: ${aRes.changes}`);

  const eRes = db.prepare('DELETE FROM engrams WHERE id IN (SELECT id FROM evict_ids)').run();
  console.log(`  engrams evicted: ${eRes.changes}`);
});

try {
  evict();
} catch (e) {
  console.error('FAILED — rolled back:', e.message);
  db.close();
  process.exit(1);
}

db.exec(`INSERT INTO engrams_fts(engrams_fts) VALUES('rebuild')`);
console.log(`FTS rebuilt in ${((Date.now() - t0) / 1000).toFixed(1)}s total`);
db.close();
