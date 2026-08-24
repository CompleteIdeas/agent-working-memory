#!/usr/bin/env bash
# Arms must run sequentially — trace.ts uses a fixed DB and log path.
set -u
cd "$(dirname "$0")/../../.."
OUT="tests/rerank2-eval/retest"
run () {
  local name="$1"; shift
  echo "### ARM: $name ###"
  env "$@" npx tsx tests/locomo-eval/trace.ts > "$OUT/$name.txt" 2>"$OUT/$name.err"
  local rc=$?
  cp tests/locomo-eval/trace-log.jsonl "$OUT/$name.jsonl" 2>/dev/null || echo "WARN: no jsonl for $name"
  [ $rc -ne 0 ] && echo "!!! ARM $name EXITED $rc !!!"
  grep -E "arm=|success@1|ADVERSARIAL|multi-hop|single-hop" "$OUT/$name.txt"
}
# baseline re-run confirms phase 9b is a true no-op when the flag is unset.
run baseline-recheck AWM_NOOP=1
run rerank2          AWM_RERANK2=1
echo "### DONE ###"
