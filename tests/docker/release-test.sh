#!/usr/bin/env bash
# Runs INSIDE a clean node:22 container. Validates the 0.14.6 tarball the way a brand-new
# user would get it: global install, `awm setup`, then the two things that cannot be
# demonstrated on the host right now because its MCP processes are all 0.14.1 —
#   (a) a second process walks to the next free hook port instead of giving up
#   (b) each shipped hook routes to the sidecar for ITS OWN agent
set -u
PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
chk()  { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

echo "############ 1. install the packed tarball globally ############"
npm install -g /tmp/awm.tgz --loglevel=error >/tmp/install.log 2>&1
if [ $? -ne 0 ]; then echo "  install FAILED:"; tail -20 /tmp/install.log; exit 1; fi
echo "  awm on PATH: $(command -v awm)"
echo "  version    : $(awm --version 2>/dev/null || node -e "console.log(require('/usr/local/lib/node_modules/agent-working-memory/package.json').version)")"

echo
echo "############ 2. awm setup claude-code --global ############"
export HOME=/root
mkdir -p /work/proj /work/personal-proj /data
cd /work/proj
awm setup claude-code --global --db-path /data/work.db 2>&1 | sed 's/^/  /'

echo
echo "############ 3. what did setup write? ############"
chk "~/.mcp.json created"                      "test -f \$HOME/.mcp.json"
chk "~/.claude/settings.json created"          "test -f \$HOME/.claude/settings.json"
chk "~/.claude/CLAUDE.md created"              "test -f \$HOME/.claude/CLAUDE.md"
for f in awm-find-sidecar.cjs awm-checkpoint.cjs awm-prime.cjs awm-db-mutation-reminder.cjs awm-hooks.json; do
  chk "hook installed: $f"                     "test -f \$HOME/.claude/hooks/$f"
done
chk "settings.json has NO inline curl"         "! grep -q curl \$HOME/.claude/settings.json"
SEC=$(node -e "console.log(require(process.env.HOME+'/.mcp.json').mcpServers['agent-working-memory'].env.AWM_HOOK_SECRET)")
chk "bearer secret NOT in settings.json"       "! grep -q '$SEC' \$HOME/.claude/settings.json"
chk "UserPromptSubmit prime hook wired"        "grep -q awm-prime.cjs \$HOME/.claude/settings.json"
chk "recommended rerank flags written"         "grep -q AWM_RERANK_WINDOW \$HOME/.claude/settings.json || grep -q AWM_RERANK_WINDOW \$HOME/.mcp.json"
chk "CLAUDE.md guidance mentions recall_id"    "grep -q recall_id \$HOME/.claude/CLAUDE.md"
chk "CLAUDE.md guidance mentions ABSTAINED"    "grep -q 'RECALL ABSTAINED' \$HOME/.claude/CLAUDE.md"
echo "  agent id chosen: $(node -e "console.log(require(process.env.HOME+'/.mcp.json').mcpServers['agent-working-memory'].env.AWM_AGENT_ID)")"

echo
echo "############ 4. a second project pinned to a different agent ############"
node -e '
const fs=require("fs");
const home=process.env.HOME;
const sec=require(home+"/.mcp.json").mcpServers["agent-working-memory"].env.AWM_HOOK_SECRET;
fs.writeFileSync("/work/personal-proj/.mcp.json", JSON.stringify({mcpServers:{"agent-working-memory":{
  command:"node",args:["x"],env:{AWM_AGENT_ID:"personal",AWM_HOOK_SECRET:sec,AWM_HOOK_PORT:"8401",AWM_HOOK_PORT_RANGE:"10",AWM_DB_PATH:"/data/personal.db"}}}},null,2));
'
echo "  /work/personal-proj/.mcp.json -> agent personal, same port preference 8401"

echo
echo "############ 5. start TWO MCP servers, both preferring 8401 ############"
MCP=/usr/local/lib/node_modules/agent-working-memory/dist/mcp.js
start() { # name agent db
  ( AWM_DB_PATH="$3" AWM_AGENT_ID="$2" AWM_HOOK_PORT=8401 AWM_HOOK_SECRET="$SEC" \
    AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1 \
    node "$MCP" </dev/zero >"/tmp/$1.out" 2>"/tmp/$1.err" & echo $! > "/tmp/$1.pid" )
}
start work work /data/work.db
sleep 1
start personal personal /data/personal.db
cat > /tmp/probe.cjs <<'PROBE'
const http=require('http');
http.get({host:'127.0.0.1',port:Number(process.argv[2]),path:'/health',timeout:1500},r=>{
  let d='';r.on('data',c=>d+=c);r.on('end',()=>{process.stdout.write(d);process.exit(0);});
}).on('error',()=>process.exit(1)).on('timeout',function(){this.destroy();process.exit(1);});
PROBE
probe() { node /tmp/probe.cjs "$1" 2>/dev/null; }
echo "  waiting for both to bind..."
for i in $(seq 1 180); do
  A=$(probe 8401); B=$(probe 8402)
  [ -n "$A" ] && [ -n "$B" ] && break
  sleep 1
done
echo "  after ${i}s:"
echo "    8401: ${A:-<nothing>}"
echo "    8402: ${B:-<nothing>}"

echo
echo "############ 6. THE PORT-WALKING FIX (0.14.2) ############"
fld() { printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)[process.argv[1]]))}catch{process.stdout.write("")}})' "$2"; }
A_AGENT=$(fld "$A" agentId); B_AGENT=$(fld "$B" agentId)
A_PORT=$(fld "$A" port);     B_PORT=$(fld "$B" port)
A_VER=$(fld "$A" version)
echo "    8401 -> agent=$A_AGENT port=$A_PORT version=$A_VER"
echo "    8402 -> agent=$B_AGENT port=$B_PORT"
chk "a sidecar bound the preferred port 8401"    "[ -n \"$A\" ]"
chk "the second WALKED to 8402 instead of dying" "[ -n \"$B\" ]"
chk "8401 and 8402 serve DIFFERENT agents"       "[ \"$A_AGENT\" = work ] && [ \"$B_AGENT\" = personal ]"
chk "/health reports the real bound port"        "[ \"$A_PORT\" = 8401 ] && [ \"$B_PORT\" = 8402 ]"
chk "/health reports the version"                "[ \"$A_VER\" = 0.14.6 ]"

echo
echo "############ 7. the shipped hooks route to their OWN agent ############"
run_hook() { printf '%s' "$2" | node "$HOME/.claude/hooks/$1" 2>/tmp/hook.err; }
export AWM_HOOK_DEBUG=1
rm -f "$HOME/.claude/hooks/awm-hooks.log"
run_hook awm-checkpoint.cjs "{\"hook_event_name\":\"PreCompact\",\"cwd\":\"/work/proj\"}" >/dev/null
run_hook awm-checkpoint.cjs "{\"hook_event_name\":\"SessionEnd\",\"cwd\":\"/work/personal-proj\"}" >/dev/null
run_hook awm-prime.cjs "{\"hook_event_name\":\"UserPromptSubmit\",\"cwd\":\"/work/proj\",\"prompt\":\"What did we decide about the sidecar port range?\"}" >/dev/null
run_hook awm-prime.cjs "{\"hook_event_name\":\"UserPromptSubmit\",\"cwd\":\"/work/proj\",\"prompt\":\"hi\"}" >/dev/null
echo "  hook debug log:"
sed 's/^/    /' "$HOME/.claude/hooks/awm-hooks.log" 2>/dev/null
WORKPORT=$A_PORT
PERSPORT=$B_PORT
chk "work-project checkpoint went to the work sidecar"      "grep -q '\"agent\":\"work\".*\"port\":$WORKPORT' \$HOME/.claude/hooks/awm-hooks.log"
chk "personal-project checkpoint went to the OTHER sidecar" "grep -q '\"agent\":\"personal\".*\"port\":$PERSPORT' \$HOME/.claude/hooks/awm-hooks.log"
chk "prime reached its sidecar (status 200)"                "grep -q '\"hook\":\"prime\".*\"status\":200' \$HOME/.claude/hooks/awm-hooks.log"
chk "short prompt made NO network call"                     "[ \$(grep -c '\"hook\":\"prime\"' \$HOME/.claude/hooks/awm-hooks.log) -eq 1 ]"

echo
echo "############ 8. prime off switch ############"
touch "$HOME/.claude/hooks/awm-prime.disabled"
BEFORE=$(grep -c '"hook":"prime"' "$HOME/.claude/hooks/awm-hooks.log")
run_hook awm-prime.cjs "{\"hook_event_name\":\"UserPromptSubmit\",\"cwd\":\"/work/proj\",\"prompt\":\"What did we decide about the sidecar port range?\"}" >/dev/null
AFTER=$(grep -c '"hook":"prime"' "$HOME/.claude/hooks/awm-hooks.log")
chk "awm-prime.disabled silences the hook"  "[ $BEFORE -eq $AFTER ]"
rm -f "$HOME/.claude/hooks/awm-prime.disabled"

echo
echo "############ 9. awm doctor sees the live sidecars ############"
cd /work/proj
awm doctor claude-code 2>&1 | sed 's/^/  /'

echo
echo "############ 10. checkpoint actually persisted? ############"
node -e "
const p='/data/work.db';
try {
  const db=require('/usr/local/lib/node_modules/agent-working-memory/node_modules/better-sqlite3')(p,{readonly:true});
  const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name);
  for (const n of ['conscious_state','engrams']) if (t.includes(n))
    console.log('  '+n+': '+db.prepare('SELECT COUNT(*) c FROM '+n).get().c+' rows');
} catch(e) { console.log('  (sqlite check skipped: '+e.message.slice(0,60)+')'); }
"

echo
echo "############ cleanup ############"
for n in work personal; do [ -f /tmp/$n.pid ] && kill "$(cat /tmp/$n.pid)" 2>/dev/null; done
sleep 1
echo
echo "================ RESULT: $PASS passed, $FAIL failed ================"
[ "$FAIL" -eq 0 ] || { echo; echo "--- work stderr (tail) ---"; tail -15 /tmp/work.err 2>/dev/null; }
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
