#!/usr/bin/env bash
# Both arms, DISTINCT PORTS, one invocation.
set -u
cd "$(dirname "$0")/../../.."
export LOCOMO_CONVS="${LOCOMO_CONVS:-2}"
BENCH_PORT=8541 bash tests/locomo-eval/bench/run-arm.sh A-base   AWM_NOOP=1
BENCH_PORT=8542 bash tests/locomo-eval/bench/run-arm.sh B-winrr  AWM_RERANK_WINDOW=query AWM_RERANK2=1
echo "### PAIR COMPLETE ###"
