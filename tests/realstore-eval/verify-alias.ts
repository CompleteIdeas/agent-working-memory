import { aliasTermsFor, aliasMap } from '../../src/core/alias-map.js';
process.env.AWM_ALIASES = '1';
const m = aliasMap();
console.log('alias map categories:', Object.keys(m).length);
for (const q of ['azure app service plan capacity increase internal application',
                 'deploy pipeline failure', 'equihub task fork multipart']) {
  console.log(`  "${q.slice(0,44)}" -> [${aliasTermsFor(q).join(', ') || '(none)'}]`);
}
