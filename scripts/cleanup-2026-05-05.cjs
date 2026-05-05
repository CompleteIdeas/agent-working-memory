#!/usr/bin/env node
// Prune lme_*/bench_*/eval_*/test_* agent memories + low-salience non-claude-code memories
// One-shot cleanup script. Uses better-sqlite3 (FTS5 enabled).

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'memory.db');
console.log(`Opening: ${dbPath}`);
const db = new Database(dbPath);

const before = {
  engrams: db.prepare('SELECT COUNT(*) AS c FROM engrams').get().c,
  associations: db.prepare('SELECT COUNT(*) AS c FROM associations').get().c,
  activation_events: db.prepare('SELECT COUNT(*) AS c FROM activation_events').get().c,
};
console.log('BEFORE:', before);

const startedAt = Date.now();

const cleanup = db.transaction(() => {
  console.log('Identifying engrams to delete...');
  db.exec(`
    CREATE TEMP TABLE to_delete AS
    SELECT id FROM engrams
    WHERE agent_id LIKE 'lme_%'
       OR agent_id LIKE 'bench_%'
       OR agent_id LIKE 'eval_%'
       OR agent_id LIKE 'test_%'
       OR (salience < 0.2 AND agent_id != 'claude-code')
  `);
  const toDelete = db.prepare('SELECT COUNT(*) AS c FROM to_delete').get().c;
  console.log(`  to delete: ${toDelete} engrams`);

  console.log('Deleting associations...');
  const assocResult = db.prepare(`
    DELETE FROM associations
    WHERE from_engram_id IN (SELECT id FROM to_delete)
       OR to_engram_id IN (SELECT id FROM to_delete)
  `).run();
  console.log(`  associations deleted: ${assocResult.changes}`);

  console.log('Deleting engrams (FTS triggers will run)...');
  const engramResult = db.prepare('DELETE FROM engrams WHERE id IN (SELECT id FROM to_delete)').run();
  console.log(`  engrams deleted: ${engramResult.changes}`);
});

try {
  cleanup();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Transaction committed in ${elapsed}s`);
} catch (e) {
  console.error('FAILED — rolled back:', e.message);
  process.exit(1);
}

console.log('Rebuilding FTS index...');
db.exec(`INSERT INTO engrams_fts(engrams_fts) VALUES('rebuild')`);
console.log('FTS rebuilt');

console.log('Optimizing FTS...');
db.exec(`INSERT INTO engrams_fts(engrams_fts) VALUES('optimize')`);
console.log('FTS optimized');

const after = {
  engrams: db.prepare('SELECT COUNT(*) AS c FROM engrams').get().c,
  associations: db.prepare('SELECT COUNT(*) AS c FROM associations').get().c,
  activation_events: db.prepare('SELECT COUNT(*) AS c FROM activation_events').get().c,
};
console.log('AFTER:', after);
console.log('Removed:', {
  engrams: before.engrams - after.engrams,
  associations: before.associations - after.associations,
});

db.close();
console.log('Done.');
