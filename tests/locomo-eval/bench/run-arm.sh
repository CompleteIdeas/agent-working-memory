#!/usr/bin/env bash
# Run ONE benchmark arm.  Usage: BENCH_PORT=<port> run-arm.sh <name> [ENV=VAL ...]
#
# HARNESS SAFETY — learned the hard way (2026-08-23):
# An earlier version reused one port across arms and tore the server down with a
# plain `kill`. On Windows that left the process alive, so the SECOND arm never
# bound the port, its health check passed against the SURVIVING first-arm server,
# and both arms silently benchmarked the same process — producing a bogus
# "the flag has no effect" result. Three defences now:
#   1. a distinct port per arm,
#   2. refuse to start if anything already answers on that port,
#   3. taskkill /T /F the whole tree, then wait for the port to actually free.
set -u
cd "$(dirname "$0")/../../.."
OUT="tests/locomo-eval/bench"
PORT="${BENCH_PORT:?BENCH_PORT must be set — distinct per arm}"
NAME="$1"; shift

DB="$(mktemp -u)-awm-bench-$NAME.db"
SRV_PID=""
cleanup() {
  # Kill by PORT, not by our child's PID: `npx` re-parents the real node
  # process, so taskkill /T on the wrapper finds no children and the server
  # survives. Killing whatever actually holds the port is the reliable form.
  for lp in $(netstat -ano 2>/dev/null | grep -E ":$PORT[[:space:]]+.*LISTENING" | awk '{print $5}' | sort -u); do
    powershell.exe -NoProfile -Command "taskkill /PID $lp /T /F" >/dev/null 2>&1
  done
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  for i in $(seq 1 15); do
    curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || break
    sleep 1
  done
  rm -f "$DB" "$DB-wal" "$DB-shm" 2>/dev/null
}
trap cleanup EXIT INT TERM

# (2) refuse to run against a survivor
if curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "FATAL: something already answers on port $PORT — refusing to run '$NAME' against a stale server"
  exit 2
fi

echo "### ARM: $NAME  (port=$PORT, convs=${LOCOMO_CONVS:-all}) ###"
env AWM_PORT="$PORT" AWM_DB_PATH="$DB" "$@" npx tsx src/index.ts > "$OUT/$NAME.server.log" 2>&1 &
SRV_PID=$!

for i in $(seq 1 90); do
  curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  kill -0 "$SRV_PID" 2>/dev/null || { echo "SERVER DIED"; tail -20 "$OUT/$NAME.server.log"; exit 1; }
  sleep 1
done
curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || { echo "health never came up"; exit 1; }
grep -q "EADDRINUSE" "$OUT/$NAME.server.log" && { echo "FATAL: EADDRINUSE on $PORT"; exit 2; }

# (4) THE IMPORTANT ONE — make the server PROVE it is configured as asked.
# Port hygiene stops one instance of "measured a stale server"; this stops the
# whole class, including a server that started before an env change, a typo'd
# flag name, or a flag the code silently ignores. Without this the failure is
# a plausible-looking number instead of an error.
FP=$(curl -s -m 5 "http://127.0.0.1:$PORT/health" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const j=JSON.parse(s);console.log(JSON.stringify(j.recall||{}));}catch{console.log('{}')}})")
echo "server reports recall config: $FP"
for kv in "$@"; do
  case "$kv" in
    AWM_NOOP=*) continue ;;                      # deliberate placeholder, not a real flag
    *=*)
      k="${kv%%=*}"; v="${kv#*=}"
      echo "$FP" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const j=JSON.parse(s||'{}'); const got=(j.flags||{})['$k'];
  if(got!=='$v'){console.error('FATAL: server reports $k='+JSON.stringify(got)+' but this arm set $v — refusing to record a measurement of a differently-configured system');process.exit(3)}})" || exit 3
      ;;
  esac
done
echo "config verified for arm $NAME"
echo "$FP" > "$OUT/$NAME.recall-config.json"
echo "server up (pid $SRV_PID, port $PORT)"

npx tsx tests/locomo-eval/runner.ts "http://127.0.0.1:$PORT" > "$OUT/$NAME.txt" 2>&1
echo "runner exit $?"
grep -a -E "OVERALL:|GRADE|WEAKEST|STRONGEST" "$OUT/$NAME.txt" | head -5
