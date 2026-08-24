#!/usr/bin/env bash
# K sweep. With K=10 (== return limit) phase 9b is PURE REORDERING of the
# returned set. With K>limit it also changes MEMBERSHIP — the reranker can pull
# a candidate from deeper in the 40-item pool into the returned top-10. That is
# a strictly bigger behavioural change, so it is measured, not assumed.
set -u
cd "$(dirname "$0")/../../.."
OUT="tests/rerank2-eval/retest"
for K in 20 40; do
  echo "### ARM: rerank2-k$K ###"
  env AWM_RERANK2=1 AWM_RERANK2_K=$K npx tsx tests/locomo-eval/trace.ts > "$OUT/rerank2-k$K.txt" 2>"$OUT/rerank2-k$K.err"
  cp tests/locomo-eval/trace-log.jsonl "$OUT/rerank2-k$K.jsonl" 2>/dev/null
  grep -E "success@1|ADVERSARIAL" "$OUT/rerank2-k$K.txt"
done
echo "### DONE ###"
