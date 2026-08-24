#!/usr/bin/env bash
# Both arms, DISTINCT PORTS, one invocation.
set -u
cd "$(dirname "$0")/../../.."
export LOCOMO_CONVS="${LOCOMO_CONVS:-2}"
BENCH_PORT=8541 bash tests/locomo-eval/bench/run-arm.sh A-base   AWM_NOOP=1
BENCH_PORT=8542 bash tests/locomo-eval/bench/run-arm.sh B-winrr  AWM_RERANK_WINDOW=query AWM_RERANK2=1
# Final guard: two arms that report the SAME recall config were not actually
# different arms. That is precisely the failure that produced a bogus
# "no effect" result on 2026-08-23.
A=$(cat tests/locomo-eval/bench/A-base.recall-config.json 2>/dev/null)
B=$(cat tests/locomo-eval/bench/B-winrr.recall-config.json 2>/dev/null)
if [ "$A" = "$B" ]; then
  echo "FATAL: both arms report identical recall config — they are not different arms."
  echo "  A: $A"
  echo "  B: $B"
  exit 4
fi
echo "arms verified distinct:"
echo "  A: $A"
echo "  B: $B"
echo "### PAIR COMPLETE ###"
