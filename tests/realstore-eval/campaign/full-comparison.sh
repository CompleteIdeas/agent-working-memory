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
# ONE_PAIR=1 runs only the first missing pair then exits — 8 pairs at 450 probes
# far exceeds a single background task's lifetime, and a killed run that
# restarts from the top never converges. With ONE_PAIR the caller invokes it
# repeatedly and each invocation makes exactly one unit of progress.
set -u
cd "$(dirname "$0")/../../.."
ONE_PAIR="${ONE_PAIR:-0}"
DID_ONE=0
OUT="tests/realstore-eval/campaign/comparison.tsv"
[ -f "$OUT" ] || printf 'suite\tarm\ts@1\ts@5\tMRR\tadversarial\textra\n' > "$OUT"

RECO="AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1"

have () { grep -qP "^$1\t$2\t" "$OUT" 2>/dev/null; }

# ONE_PAIR: make exactly one unit of progress per invocation, then exit. Eight pairs at
# 450 probes far exceeds one background task's lifetime, and a killed run that restarts
# from the top never converges. `record` sets DID_ONE; this stops once something was
# actually measured (a skipped already-have pair is not progress).
# WAS MISSING ENTIRELY — called 8 times, defined 0 times. Without `set -e` that is a
# stderr line and a shrug, so ONE_PAIR never stopped anything.
stop_if_done () {
  [ "$ONE_PAIR" = "1" ] && [ "$DID_ONE" = "1" ] || return 0
  echo "### ONE_PAIR: one measurement recorded, exiting ###"
  exit 0
}

record () {  # suite arm s1 s5 mrr adv extra
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "${7:-}" >> "$OUT"
  echo "  recorded: $1 / $2 -> s@1 $3"
  DID_ONE=1
}

run_realstore () {  # suite-label fixture arm-label envflags
  local label="$1" fixture="$2" arm="$3"; shift 3
  have "$label" "$arm" && { echo "  skip (have): $label / $arm"; return; }
  local o
  o=$(env "$@" REALSTORE_FIXTURE="$fixture" REALSTORE_LIMIT=450 \
        npx tsx tests/realstore-eval/runner.ts 2>/dev/null)
  local s1 s5 mrr adv
  s1=$(printf '%s' "$o" | grep -aoE 'success@1 +[0-9.]+%' | head -1 | grep -oE '[0-9.]+%' | tr -d '%')
  s5=$(printf '%s' "$o" | grep -aoE 'success@5 +[0-9.]+%' | head -1 | grep -oE '[0-9.]+%' | tr -d '%')
  mrr=$(printf '%s' "$o" | grep -aoE 'MRR +[0-9.]+%' | head -1 | grep -oE '[0-9.]+%' | tr -d '%')
  adv=$(printf '%s' "$o" | grep -aoE 'silent: +[0-9.]+%' | head -1 | grep -oE '[0-9.]+%' | tr -d '%')
  [ -z "$s1" ] && { echo "  FAILED: $label / $arm (no metrics)"; return 1; }
  # A multi-line capture silently produced mangled TSV rows for most of this campaign.
  # Refuse to record rather than write a row that looks like data and is not.
  case "$s1$s5$mrr$adv" in *[!0-9.]*|*"
"*) echo "  FAILED: $label / $arm (malformed metric capture)"; return 1;; esac
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
stop_if_done
run_realstore category fixture-category.json recommended $RECO
stop_if_done

echo "### identifier fixture (no-regression guard) ###"
run_realstore identifier fixture.json baseline    AWM_NOOP=1
stop_if_done
run_realstore identifier fixture.json recommended $RECO
stop_if_done

echo "### long-memory (truncation) ###"
run_longmem baseline    AWM_NOOP=1
stop_if_done
run_longmem recommended $RECO
stop_if_done

echo "### temporal ###"
run_temporal baseline    AWM_NOOP=1
stop_if_done
run_temporal recommended $RECO
stop_if_done

echo "### DONE ###"
column -t -s $'\t' "$OUT"
