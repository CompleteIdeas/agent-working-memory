set -u
cd /c/Users/robert/Personal-Projects/AgentWorkingMemory
BASE="AWM_RERANK2=1 AWM_RERANK_WINDOW=query"
echo "########## OPTION 2 — tags into the rerank passage ##########"
for arm in "A-baseline:" "B-tags:AWM_RERANK_TAGS=1" "C-tags-len160:AWM_RERANK_TAGS=1 AWM_RERANK_TAGS_LEN=160"; do
  n="${arm%%:*}"; f="${arm#*:}"
  echo "=== $n ==="
  env $BASE $f REALSTORE_LIMIT=400 npx tsx tests/realstore-eval/runner.ts 2>/dev/null \
    | grep -aE "arm=|success@1|adversarial correctly|SUFFICIENCY|NET "
done
echo "########## temporal cross-check (must not fall) ##########"
for arm in "A-baseline:" "B-tags:AWM_RERANK_TAGS=1"; do
  n="${arm%%:*}"; f="${arm#*:}"
  printf "  %-12s " "$n"
  env $BASE $f npx tsx tests/realstore-eval/temporal-runner.ts 2>/dev/null | grep -aE "^  none" | head -1
done
echo "### OPT2 DONE ###"
