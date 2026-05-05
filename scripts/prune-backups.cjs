#!/usr/bin/env node
// Prune AWM backup directory — keep recent backups, delete older ones.
// Run hourly from cron / Windows Task Scheduler.
//
// Policy:
//   - Always keep all backups from the last 24 hours (operational safety net)
//   - Keep up to KEEP_RECENT most-recent older backups (default 6 — covers ~6 days at 1/day)
//   - Delete the rest
//   - Manual snapshots (memory-pre-*, memory-safety-*) are preserved (left for human curation)

const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const KEEP_RECENT = Number(process.env.AWM_BACKUP_KEEP || 6);
const DAY_MS = 24 * 60 * 60 * 1000;
const DRY_RUN = process.argv.includes('--dry-run');

if (!fs.existsSync(BACKUP_DIR)) {
  console.error(`Backup dir not found: ${BACKUP_DIR}`);
  process.exit(1);
}

const now = Date.now();
const files = fs.readdirSync(BACKUP_DIR)
  .filter(f => f.endsWith('.db') || f.endsWith('.db-journal'))
  .map(f => {
    const full = path.join(BACKUP_DIR, f);
    const stat = fs.statSync(full);
    return { name: f, full, mtime: stat.mtimeMs, size: stat.size };
  });

// Group: manual snapshots (preserved) vs auto-rotation backups (eligible for prune)
const isManual = (name) => /^memory-(pre-|safety-)/.test(name);
const auto = files.filter(f => !isManual(f.name));
const manual = files.filter(f => isManual(f.name));

// Sort newest first
auto.sort((a, b) => b.mtime - a.mtime);

const recent = auto.filter(f => now - f.mtime < DAY_MS);
const older = auto.filter(f => now - f.mtime >= DAY_MS);
const keepOlder = older.slice(0, KEEP_RECENT);
const toDelete = older.slice(KEEP_RECENT);

console.log(`Backup dir: ${BACKUP_DIR}`);
console.log(`  Total auto backups: ${auto.length}`);
console.log(`  Recent (<24h, all kept): ${recent.length}`);
console.log(`  Older kept (latest ${KEEP_RECENT}): ${keepOlder.length}`);
console.log(`  Older to delete: ${toDelete.length}`);
console.log(`  Manual snapshots (preserved): ${manual.length}`);

let freedBytes = 0;
for (const f of toDelete) {
  freedBytes += f.size;
  if (DRY_RUN) {
    console.log(`  [dry-run] would delete: ${f.name} (${(f.size/1024/1024).toFixed(1)} MB)`);
  } else {
    try {
      fs.unlinkSync(f.full);
      console.log(`  deleted: ${f.name} (${(f.size/1024/1024).toFixed(1)} MB)`);
    } catch (e) {
      console.error(`  FAILED to delete ${f.name}: ${e.message}`);
    }
  }
}

console.log(`${DRY_RUN ? '[dry-run] would free' : 'freed'}: ${(freedBytes/1024/1024).toFixed(1)} MB`);
