#!/bin/bash
# Self-Test Runner — uses curl + temp files for Windows compatibility
# Run: bash tests/self-test/runner.sh [base_url]

BASE_URL="${1:-http://localhost:8400}"
TMP="${TEMP:-${TMP:-/tmp}}/awm_test"
PASS=0
FAIL=0
TOTAL=0

mkdir -p $TMP

echo "AgentWorkingMemory Self-Test Runner"
echo "Target: $BASE_URL"
echo "Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Health check
curl -sf "$BASE_URL/health" -o $TMP/health.json 2>/dev/null
if [ $? -ne 0 ]; then echo "FATAL: Cannot reach server"; exit 1; fi
echo "Server: OK"

# Helpers
post() { curl -sf -X POST "$BASE_URL$1" -H "Content-Type: application/json" -d "$2" -o "$3" 2>/dev/null; }
get()  { curl -sf "$BASE_URL$1" -o "$2" 2>/dev/null; }
jq_()  { node -e "const d=require('fs').readFileSync('$1','utf8');try{const j=JSON.parse(d);const v=eval('j$2');console.log(v??'')}catch{console.log('')}"; }

record() {
  TOTAL=$((TOTAL + 1))
  if [ "$1" = "1" ]; then PASS=$((PASS + 1)); echo "  [PASS] $2 — $3"
  else FAIL=$((FAIL + 1)); echo "  [FAIL] $2 — $3"; fi
}

# Register agent
post "/agent/register" '{"name":"self-test-agent"}' $TMP/agent.json
AGENT_ID=$(jq_ "$TMP/agent.json" ".id")
echo "Agent: $AGENT_ID"

echo ""
echo "=== 1. WRITE QUALITY ==="

# 1.1 Causal → active
AC=0
for i in 0 1 2 3 4; do
  post "/memory/write" "{\"agentId\":\"$AGENT_ID\",\"concept\":\"causal $i\",\"content\":\"Root cause race condition shared state mutated without locks scenario $i\",\"eventType\":\"causal\",\"surprise\":0.7,\"causalDepth\":0.8,\"resolutionEffort\":0.6}" $TMP/w1_$i.json
  D=$(jq_ "$TMP/w1_$i.json" ".disposition")
  [ "$D" = "active" ] && AC=$((AC + 1))
done
[ "$AC" -eq 5 ] && record 1 "1.1 Causal → active" "$AC/5" || record 0 "1.1 Causal → active" "$AC/5"

# 1.2 Trivial → discard
DC=0
for i in 0 1 2 3 4; do
  post "/memory/write" "{\"agentId\":\"$AGENT_ID\",\"concept\":\"routine $i\",\"content\":\"File read completed successfully $i\",\"eventType\":\"observation\",\"surprise\":0,\"causalDepth\":0,\"resolutionEffort\":0}" $TMP/w2_$i.json
  D=$(jq_ "$TMP/w2_$i.json" ".disposition")
  [ "$D" = "discard" ] && DC=$((DC + 1))
done
[ "$DC" -eq 5 ] && record 1 "1.2 Trivial → discard" "$DC/5" || record 0 "1.2 Trivial → discard" "$DC/5"

# 1.3 Decisions → active
DA=0
for i in 0 1 2 3 4; do
  post "/memory/write" "{\"agentId\":\"$AGENT_ID\",\"concept\":\"decision $i\",\"content\":\"Chose approach A over B better error recovery scenario $i\",\"eventType\":\"decision\",\"decisionMade\":true,\"surprise\":0.3,\"causalDepth\":0.4}" $TMP/w3_$i.json
  D=$(jq_ "$TMP/w3_$i.json" ".disposition")
  [ "$D" = "active" ] && DA=$((DA + 1))
done
[ "$DA" -ge 4 ] && record 1 "1.3 Decisions → active" "$DA/5" || record 0 "1.3 Decisions → active" "$DA/5"

# 1.4 Friction → staging
SC=0
for i in 0 1 2 3 4; do
  post "/memory/write" "{\"agentId\":\"$AGENT_ID\",\"concept\":\"friction $i\",\"content\":\"API returned 429 rate limit retried backoff attempt $i\",\"eventType\":\"friction\",\"surprise\":0.15,\"resolutionEffort\":0.25}" $TMP/w4_$i.json
  D=$(jq_ "$TMP/w4_$i.json" ".disposition")
  [ "$D" = "staging" ] && SC=$((SC + 1))
done
[ "$SC" -ge 3 ] && record 1 "1.4 Friction → staging" "$SC/5" || record 0 "1.4 Friction → staging" "$SC/5"

echo ""
echo "=== 2. RETRIEVAL PRECISION ==="

post "/memory/write" "{\"agentId\":\"$AGENT_ID\",\"concept\":\"database optimization\",\"content\":\"Use composite indexes on frequently queried column combinations for database performance\",\"eventType\":\"causal\",\"surprise\":0.6,\"causalDepth\":0.7,\"resolutionEffort\":0.5}" $TMP/db.json
post "/memory/write" "{\"agentId\":\"$AGENT_ID\",\"concept\":\"react rendering\",\"content\":\"React useMemo useCallback prevent unnecessary rerenders in component trees\",\"eventType\":\"causal\",\"surprise\":0.5,\"causalDepth\":0.6,\"resolutionEffort\":0.4}" $TMP/react.json

# 2.1 Topic match
post "/memory/activate" "{\"agentId\":\"$AGENT_ID\",\"context\":\"database query optimization indexes\"}" $TMP/a1.json
TOP=$(jq_ "$TMP/a1.json" ".results[0]?.engram?.concept")
echo "$TOP" | grep -qi "database" && record 1 "2.1 Topic match" "Top: $TOP" || record 0 "2.1 Topic match" "Top: $TOP"

# 2.2 Cross-domain
post "/memory/activate" "{\"agentId\":\"$AGENT_ID\",\"context\":\"react component rendering performance hooks useMemo\"}" $TMP/a2.json
TOP=$(jq_ "$TMP/a2.json" ".results[0]?.engram?.concept")
echo "$TOP" | grep -qi "react" && record 1 "2.2 Cross-domain (react)" "Top: $TOP" || record 0 "2.2 Cross-domain (react)" "Top: $TOP"

# 2.3 No match
post "/memory/activate" "{\"agentId\":\"$AGENT_ID\",\"context\":\"quantum physics particle acceleration\",\"minScore\":0.5}" $TMP/a3.json
CNT=$(jq_ "$TMP/a3.json" ".results?.length")
[ "$CNT" = "0" ] && record 1 "2.3 No-match empty" "$CNT results" || record 0 "2.3 No-match empty" "$CNT results"

echo ""
echo "=== 3. ASSOCIATIONS ==="

post "/memory/write" "{\"agentId\":\"$AGENT_ID\",\"concept\":\"typescript async await\",\"content\":\"async await typescript pattern simplifies asynchronous code flow handling\",\"eventType\":\"causal\",\"surprise\":0.5,\"causalDepth\":0.6,\"resolutionEffort\":0.4}" $TMP/ts1.json
ID1=$(jq_ "$TMP/ts1.json" ".engram?.id")
post "/memory/write" "{\"agentId\":\"$AGENT_ID\",\"concept\":\"promise error handling\",\"content\":\"unhandled promise rejections crash node use async await try catch\",\"eventType\":\"friction\",\"surprise\":0.6,\"causalDepth\":0.5,\"resolutionEffort\":0.7}" $TMP/ts2.json
ID2=$(jq_ "$TMP/ts2.json" ".engram?.id")

for i in 1 2 3 4 5; do
  post "/memory/activate" "{\"agentId\":\"$AGENT_ID\",\"context\":\"typescript async await promise error handling patterns\"}" $TMP/coact_$i.json
done

get "/memory/$ID1" $TMP/detail1.json
HAS_EDGE=$(node -e "
const d=require('fs').readFileSync('$TMP/detail1.json','utf8');
const j=JSON.parse(d);
const has=j.associations?.some(a=>a.fromEngramId==='$ID2'||a.toEngramId==='$ID2');
console.log(has?'yes':'no')
")
[ "$HAS_EDGE" = "yes" ] && record 1 "3.1 Co-activation edges" "Edge found" || record 0 "3.1 Co-activation edges" "No edge"

echo ""
echo "=== 4. RETRACTION ==="

post "/memory/write" "{\"agentId\":\"$AGENT_ID\",\"concept\":\"javascript equality\",\"content\":\"triple equals javascript checks value only not type\",\"eventType\":\"causal\",\"surprise\":0.6,\"causalDepth\":0.5,\"resolutionEffort\":0.4}" $TMP/wrong.json
WRONG_ID=$(jq_ "$TMP/wrong.json" ".engram?.id")

post "/memory/retract" "{\"agentId\":\"$AGENT_ID\",\"targetEngramId\":\"$WRONG_ID\",\"reason\":\"Wrong\",\"counterContent\":\"JavaScript === checks both type AND value\"}" $TMP/retract.json
CORR_ID=$(jq_ "$TMP/retract.json" ".correctionId")
[ -n "$CORR_ID" ] && record 1 "4.1 Creates correction" "ID: $CORR_ID" || record 0 "4.1 Creates correction" "None"

post "/memory/activate" "{\"agentId\":\"$AGENT_ID\",\"context\":\"javascript equality operator triple equals\"}" $TMP/a_retract.json
FOUND_WRONG=$(node -e "const d=require('fs').readFileSync('$TMP/a_retract.json','utf8');const j=JSON.parse(d);console.log(j.results?.some(r=>r.engram.id==='$WRONG_ID')?'yes':'no')")
[ "$FOUND_WRONG" = "no" ] && record 1 "4.2 Retracted hidden" "Correct" || record 0 "4.2 Retracted hidden" "Still visible"

FOUND_CORR=$(node -e "const d=require('fs').readFileSync('$TMP/a_retract.json','utf8');const j=JSON.parse(d);console.log(j.results?.some(r=>r.engram.id==='$CORR_ID')?'yes':'no')")
[ "$FOUND_CORR" = "yes" ] && record 1 "4.3 Correction surfaces" "Found" || record 0 "4.3 Correction surfaces" "Not found"

echo ""
echo "=== 5. FEEDBACK ==="

post "/memory/write" "{\"agentId\":\"$AGENT_ID\",\"concept\":\"feedback test\",\"content\":\"test memory for feedback scoring\",\"eventType\":\"decision\",\"decisionMade\":true,\"surprise\":0.5,\"causalDepth\":0.4}" $TMP/fb.json
FB_ID=$(jq_ "$TMP/fb.json" ".engram?.id")
CONF_BEFORE=$(jq_ "$TMP/fb.json" ".engram?.confidence")

post "/memory/feedback" "{\"engramId\":\"$FB_ID\",\"useful\":true,\"context\":\"helpful\"}" $TMP/fb_pos.json
get "/memory/$FB_ID" $TMP/fb_after.json
CONF_AFTER=$(jq_ "$TMP/fb_after.json" ".engram?.confidence")

INCREASED=$(node -e "console.log(parseFloat('$CONF_AFTER')>parseFloat('$CONF_BEFORE')?'yes':'no')")
[ "$INCREASED" = "yes" ] && record 1 "5.1 Positive feedback" "Before: $CONF_BEFORE → After: $CONF_AFTER" || record 0 "5.1 Positive feedback" "Before: $CONF_BEFORE → After: $CONF_AFTER"

echo ""
echo "=== 6. EVAL METRICS ==="

get "/agent/$AGENT_ID/metrics?window=24" $TMP/metrics.json
ACTIVE_CT=$(jq_ "$TMP/metrics.json" ".metrics?.activeEngramCount")
[ -n "$ACTIVE_CT" ] && [ "$ACTIVE_CT" != "0" ] && [ "$ACTIVE_CT" != "" ] && record 1 "6.1 Metrics compute" "Active: $ACTIVE_CT" || record 0 "6.1 Metrics compute" "Active: $ACTIVE_CT"

echo ""
echo "============================================================"
echo "SELF-TEST REPORT"
echo "============================================================"
echo "Passed: $PASS / $TOTAL"
echo "Failed: $FAIL / $TOTAL"
SCORE=$(node -e "console.log(($PASS/$TOTAL*100).toFixed(1)+'%')")
echo "Score: $SCORE"

if [ "$FAIL" -eq 0 ]; then echo "GRADE: EXCELLENT"
elif [ "$FAIL" -le 2 ]; then echo "GRADE: GOOD"
elif [ "$FAIL" -le 4 ]; then echo "GRADE: FAIR"
else echo "GRADE: NEEDS WORK"
fi
echo "============================================================"

rm -rf $TMP
exit $FAIL
