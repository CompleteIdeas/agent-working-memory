#!/usr/bin/env bash
# Official LoCoMo benchmark (retrieval-only: Recall@5/@10, MRR, nDCG@10,
# adversarial rejection). Needs a live AWM server on :8400.
#
# Each arm gets a FRESH TEMP DB via AWM_DB_PATH so the live store at
# AgentSynapse/packages/awm/memory.db is never touched, and arms cannot
# contaminate each other.
set -u
cd "$(dirname "$0")/../../.."
OUT="tests/locomo-eval/bench"
PORT=8411     # not 8400 — avoid colliding with anything already bound

run_arm () {
  local name="$1"; shift
  local db; db="$(mktemp -u)-awm-bench-$name.db"
  echo "### ARM: $name (db=$db) ###"

  env AWM_PORT=$PORT AWM_DB_PATH="$db" "$@" npx tsx src/index.ts > "$OUT/$name.server.log" 2>&1 &
  local pid=$!

  # wait for health rather than sleeping blind
  for i in $(seq 1 90); do
    if curl -s "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
    if ! kill -0 $pid 2>/dev/null; then echo "SERVER DIED — see $OUT/$name.server.log"; tail -20 "$OUT/$name.server.log"; return 1; fi
    sleep 1
  done
  curl -s "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || { echo "health never came up"; kill $pid 2>/dev/null; return 1; }
  echo "server up (pid $pid)"

  npx tsx tests/locomo-eval/runner.ts "http://127.0.0.1:$PORT" > "$OUT/$name.txt" 2>&1
  echo "--- $name ---"
  tail -30 "$OUT/$name.txt"

  kill $pid 2>/dev/null; wait $pid 2>/dev/null
  rm -f "$db" "$db-wal" "$db-shm"
}

run_arm baseline        AWM_NOOP=1
run_arm window-rerank2  AWM_RERANK_WINDOW=query AWM_RERANK2=1
echo "### BENCH COMPLETE ###"
