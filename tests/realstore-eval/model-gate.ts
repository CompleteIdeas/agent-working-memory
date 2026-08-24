/**
 * Availability gate for option 4: can a 768d model load and embed at all?
 * Run before committing to a full re-embed — a failed download after 8,703
 * embeds would waste far more than it costs to check first.
 */
import { embed } from '../../src/core/embeddings.js';
const t0 = Date.now();
const v = await embed('azure app service plan capacity increase internal application');
console.log(`model=${process.env.AWM_EMBED_MODEL} dims=${v.length} first-embed=${((Date.now()-t0)/1000).toFixed(1)}s`);
const t1 = Date.now();
for (let i = 0; i < 20; i++) await embed(`probe ${i} deployment pipeline capacity`);
console.log(`warm: ${((Date.now()-t1)/20).toFixed(0)}ms per embed`);
