import Database from 'better-sqlite3';
import { join } from 'node:path';
import { buildRerankPassage, rerankTagText } from '../../src/core/rerank-window.js';
const db = new Database(join(import.meta.dirname, 'snapshot', 'store.db'), { readonly: true });
const r = db.prepare("SELECT concept, content, tags FROM engrams WHERE id='2ab1866e-cc5a-4381-b9a0-4995609a2c6d'").get() as any;
const tags = JSON.parse(r.tags);
console.log('AZURE memory tags:', tags.join(', '));
console.log();
for (const on of ['0', '1']) {
  process.env.AWM_RERANK_TAGS = on;
  const p = buildRerankPassage(r.concept, r.content, 'azure app service plan capacity', 400, 'query', tags);
  console.log(`AWM_RERANK_TAGS=${on}  tagText="${rerankTagText(tags)}"`);
  console.log(`   passage tail: ...${p.slice(-110)}`);
  console.log(`   contains "azure": ${p.toLowerCase().includes('azure')}`);
  console.log();
}
db.close();
