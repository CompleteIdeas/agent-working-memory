#!/usr/bin/env bash
# Full baseline-vs-recommended comparison across EVERY eval.
#
# Writes one TSV line per (suite, arm) as it completes, so a kill costs one
# measurement rather than the whole run — this campaign has had several long
# batched runs killed, and restarting from zero each time never converges.
# Re-running skips pairs already present in the results file.
#
#   BASELINE    = shipped defaults before 2026-08-24 (no flags)
#   RECOMMENDED = AWM_RERANK2=1 + AWM_RERANK_WINDOW=query + AWM_RERANK_TAGS=1
#
# Usage: bash tests/realstore-eval/campaign/full-comparison.sh
set -u
cd "$(dirname "$0")/../../.."
OUT="tests/realstore-eval/campaign/comparison.tsv"
[ -f "$OUT" ] || printf 'suite\tarm\ts@1\ts@5\tMRR\tadversarial\textra\n' > "$OUT"

RECO="AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1"

have () { grep -qP "^$1\t$2\t" "$OUT" 2>/dev/null; }

record () {  # suite arm s1 s5 mrr adv extra
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "${7:-}" >> "$OUT"
  echo "  recorded: $1 / $2 -> s@1 $3"
}

run_realstore () {  # suite-label fixture arm-label envflags
  local label="$1" fixture="$2" arm="$3"; shift 3
  have "$label" "$arm" && { echo "  skip (have): $label / $arm"; return; }
  local o
  o=$(env "$@" REALSTORE_FIXTURE="$fixture" REALSTORE_LIMIT=450 \
        npx tsx tests/realstore-eval/runner.ts 2>/dev/null)
  local s1 s5 mrr adv
  s1=$(printf '%s' "$o" | grep -aoE 'success@1 +[0-9.]+%' | head -1 | grep -oE '[0-9.]+')
  s5=$(printf '%s' "$o" | grep -aoE 'success@5 +[0-9.]+%' | head -1 | grep -oE '[0-9.]+')
  mrr=$(printf '%s' "$o" | grep -aoE 'MRR +[0-9.]+%' | head -1 | grep -oE '[0-9.]+')
  adv=$(printf '%s' "$o" | grep -aoE 'silent: +[0-9.]+%' | head -1 | grep -oE '[0-9.]+')
  [ -z "$s1" ] && { echo "  FAILED: $label / $arm (no metrics)"; return 1; }
  record "$label" "$arm" "$s1" "$s5" "$mrr" "$adv"
}

run_longmem () {  # arm-label envflags...
  local arm="$1"; shift
  have "longmem" "$arm" && { echo "  skip (have): longmem / $arm"; return; }
  local o s1
  o=$(env "$@" npx tsx tests/longmem-eval/runner.ts 2>/dev/null)
  s1=$(printf '%s' "$o" | grep -aoE 'OVERALL +[0-9]+ +[0-9.]+%' | grep -oE '[0-9.]+%' | tr -d '%')
  [ -z "$s1" ] && { echo "  FAILED: longmem / $arm"; return 1; }
  record "longmem" "$arm" "$s1" "-" "-" "-" "answer-position eval"
}

run_temporal () {  # arm-label envflags...
  local arm="$1"; shift
  have "temporal" "$arm" && { echo "  skip (have): temporal / $arm"; return; }
  local o s1
  o=$(env "$@" npx tsx tests/realstore-eval/temporal-runner.ts 2>/dev/null)
  s1=$(printf '%s' "$o" | grep -aE '^  none' | head -1 | grep -oE '[0-9.]+%' | head -1 | tr -d '%')
  [ -z "$s1" ] && { echo "  FAILED: temporal / $arm"; return 1; }
  record "temporal" "$arm" "$s1" "-" "-" "-" "no-cue control"
}

echo "### category fixture (the retrievability target) ###"
run_realstore category fixture-category.json baseline    AWM_NOOP=1
run_realstore category fixture-category.json recommended $RECO

echo "### identifier fixture (no-regression guard) ###"
run_realstore identifier fixture.json baseline    AWM_NOOP=1
run_realstore identifier fixture.json recommended $RECO

echo "### long-memory (truncation) ###"
run_longmem baseline    AWM_NOOP=1
run_longmem recommended $RECO

echo "### temporal ###"
run_temporal baseline    AWM_NOOP=1
run_temporal recommended $RECO

echo "### DONE ###"
column -t -s $'\t' "$OUT"
