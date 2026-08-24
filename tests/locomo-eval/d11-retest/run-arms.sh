#!/usr/bin/env bash
# D11 re-test queue. Arms MUST run sequentially: trace.ts uses a fixed DB and
# a fixed trace-log.jsonl, so parallel arms would clobber each other.
#
# Arm 2 (spread, no inhibition) is the CONTROL: it should reproduce the
# historical displacing-gold regression. If it does not, the instrument is not
# measuring what parked the feature and arms 3/4 prove nothing.
set -u
cd "$(dirname "$0")/../../.."
OUT="tests/locomo-eval/d11-retest"

run () {
  local name="$1"; shift
  echo "### ARM: $name ###"
  env "$@" npx tsx tests/locomo-eval/trace.ts > "$OUT/$name.txt" 2>"$OUT/$name.err"
  cp tests/locomo-eval/trace-log.jsonl "$OUT/$name.jsonl" 2>/dev/null
  echo "--- $name done ---"
  grep -E "success@1|adversarial|multi-hop|single-hop" "$OUT/$name.txt" | head -8
}

run baseline            AWM_NOOP=1
run spread              AWM_SPREAD=1
run spread-inhibit      AWM_SPREAD=1 AWM_SPREAD_INHIBIT=0.3
run spread-inject-inhib AWM_SPREAD=1 AWM_SPREAD_INJECT=1 AWM_SPREAD_INHIBIT=0.3
echo "### ALL ARMS COMPLETE ###"
