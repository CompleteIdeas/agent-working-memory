/**
 * Replicate the R2-supersede test inline with logging.
 *
 * Run: npx tsx scripts/debug-supersede-test.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramStore } from '../src/storage/sqlite.js';
import { ActivationEngine } from '../src/engine/activation.js';
import { ConnectionEngine } from '../src/engine/connections.js';
import { performWrite } from '../src/core/write-pipeline.js';
import { computeNoveltyWithMatch } from '../src/core/salience.js';
import { embed } from '../src/core/embeddings.js';

async function main() {
  const AGENT = 'debug';
  const tmp = mkdtempSync(join(tmpdir(), 'awm-debug-'));
  const store = new EngramStore(join(tmp, 'test.db'));
  const connection = new ConnectionEngine(store, new ActivationEngine(store));

  console.log('=== Write 1: wrong ===');
  const wrong = await performWrite({ store, connectionEngine: connection }, {
    agentId: AGENT,
    concept: 'Schema for tblMemberDetails',
    content: 'columns are foo, bar, baz',
    eventType: 'observation',
  });
  console.log('  id=' + wrong.engram.id.slice(0,8) + ' action=' + wrong.action + ' stage=' + wrong.engram.stage + ' has_embedding=' + (wrong.engram.embedding != null && wrong.engram.embedding.length > 0));

  console.log('\n=== Write 2: correction (eventType=surprise → supersede) ===');
  const correction = await performWrite({ store, connectionEngine: connection }, {
    agentId: AGENT,
    concept: 'Schema for tblMemberDetails',
    content: 'CORRECTION: columns are member_id, activation_date, expiry_date',
    eventType: 'surprise',
  });
  console.log('  id=' + correction.engram.id.slice(0,8) + ' action=' + correction.action + ' has_embedding=' + (correction.engram.embedding != null && correction.engram.embedding.length > 0));
  console.log('  correction.confidence=' + correction.engram.confidence.toFixed(3) + ' stage=' + correction.engram.stage + ' salience=' + correction.engram.salience.toFixed(3));
  console.log('  correction.salience.disposition=' + correction.salience?.disposition);

  // Refresh wrong to confirm supersededBy is set
  const wrongAfter = store.getEngram(wrong.engram.id);
  console.log('  wrong.supersededBy=' + (wrongAfter?.supersededBy?.slice(0,8) ?? 'null') + ' wrong.stage=' + wrongAfter?.stage);
  // Refresh correction to confirm it's persisted with correct values
  const correctionAfter = store.getEngram(correction.engram.id);
  console.log('  correctionAfter.confidence=' + correctionAfter?.confidence.toFixed(3) + ' stage=' + correctionAfter?.stage + ' supersededBy=' + (correctionAfter?.supersededBy?.slice(0,8) ?? 'null'));
  console.log('  HEALTHY check on correction: stage===active=' + (correctionAfter?.stage === 'active') + ' && confidence>=0.3=' + ((correctionAfter?.confidence ?? 0) >= 0.3) + ' && supersededBy==null=' + (correctionAfter?.supersededBy == null));

  console.log('\n=== Pre-trace: novelty for third write ===');
  const thirdContent = 'columns are foo, bar, baz';
  const thirdConcept = 'Schema for tblMemberDetails';
  const thirdEmb = await embed(`${thirdConcept} ${thirdContent}`);
  console.log('  third embedding length: ' + thirdEmb.length);
  const novelty = await computeNoveltyWithMatch(store, AGENT, thirdConcept, thirdContent, null, thirdEmb);
  console.log('  novelty result: ' + JSON.stringify({ novelty: novelty.novelty.toFixed(3), matchScore: novelty.matchScore.toFixed(3), matchedEngramId: novelty.matchedEngramId?.slice(0,8) ?? 'null' }));

  // Find which engram was matched
  if (novelty.matchedEngramId) {
    const matched = store.getEngram(novelty.matchedEngramId);
    console.log('  matched engram: ' + matched?.concept + ' / supersededBy=' + (matched?.supersededBy?.slice(0,8) ?? 'null'));
    console.log('  matched.id===wrong.id: ' + (novelty.matchedEngramId === wrong.engram.id));
    console.log('  matched.id===correction.id: ' + (novelty.matchedEngramId === correction.engram.id));
  }

  console.log('\n=== Write 3: third (should reinforce correction via superseder chain) ===');
  const third = await performWrite({ store, connectionEngine: connection }, {
    agentId: AGENT,
    concept: thirdConcept,
    content: thirdContent,
    eventType: 'observation',
  });
  console.log('  id=' + third.engram.id.slice(0,8) + ' action=' + third.action);
  console.log('  Expected: action="reinforce", id=correction.id (' + correction.engram.id.slice(0,8) + ')');
  console.log('  Actual:   action="' + third.action + '", id=' + third.engram.id.slice(0,8));

  store.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

main().catch(err => { console.error(err); process.exit(1); });
