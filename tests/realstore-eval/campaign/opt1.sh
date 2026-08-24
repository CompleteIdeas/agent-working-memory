set -u
cd /c/Users/robert/Personal-Projects/AgentWorkingMemory
BASE="AWM_RERANK2=1 AWM_RERANK_WINDOW=query"
FIX="REALSTORE_FIXTURE=fixture-category.json REALSTORE_LIMIT=450"
echo "###### OPTION 1 — derived retrieval text (backfilled) ######"
echo "  A/B already measured on the ORIGINAL snapshot: baseline 56.4%, +tags 63.8%"
echo "=== C: embedding-half ONLY (backfilled snapshot, no rerank tags) ==="
env $BASE $FIX REALSTORE_SNAPSHOT=store-backfilled.db \
  npx tsx tests/realstore-eval/runner.ts 2>/dev/null | grep -aE "arm=|success@1|adversarial correctly|recall latency"
echo "=== D: FULL option 1 (backfilled snapshot + rerank tags) ==="
env $BASE $FIX REALSTORE_SNAPSHOT=store-backfilled.db AWM_RERANK_TAGS=1 \
  npx tsx tests/realstore-eval/runner.ts 2>/dev/null | grep -aE "arm=|success@1|adversarial correctly|recall latency"
echo "=== NO-REGRESSION guard: identifier fixture on the backfilled snapshot ==="
env $BASE REALSTORE_LIMIT=400 REALSTORE_SNAPSHOT=store-backfilled.db \
  npx tsx tests/realstore-eval/runner.ts 2>/dev/null | grep -aE "success@1|adversarial correctly"
echo "### OPT1 DONE ###"
