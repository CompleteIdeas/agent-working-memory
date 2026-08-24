set -u
cd /c/Users/robert/Personal-Projects/AgentWorkingMemory
BASE="AWM_RERANK2=1 AWM_RERANK_WINDOW=query"
echo "###### OPTION 2 on the CATEGORY fixture (the population it targets) ######"
for arm in "A-baseline:" "B-tags:AWM_RERANK_TAGS=1" "C-tags160:AWM_RERANK_TAGS=1 AWM_RERANK_TAGS_LEN=160"; do
  n="${arm%%:*}"; f="${arm#*:}"
  echo "=== $n ==="
  env $BASE $f REALSTORE_FIXTURE=fixture-category.json REALSTORE_LIMIT=450 \
    npx tsx tests/realstore-eval/runner.ts 2>/dev/null | grep -aE "arm=|success@1|adversarial correctly"
done
echo "### DONE ###"
