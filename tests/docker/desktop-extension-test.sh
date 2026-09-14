#!/usr/bin/env bash
# Runs INSIDE a clean node:22 container.  `npm run test:docker -- desktop`
#
# WHY THIS EXISTS
# ---------------
# The cross-surface end-to-end test proves the Desktop extension works — but it sets
# AWM_PACKAGE_ROOT to the repository checkout, because that is what exists on the developer's
# machine. A real Desktop user has no checkout. They install the npm package globally and the
# launcher has to FIND it.
#
# That resolution path — global npm root, on a machine with no AWM source anywhere — is the
# one a stranger actually takes, and nothing tested it. `require.resolve` does not search
# global roots, which is exactly the kind of thing that works on the author's laptop and
# fails for everyone else.
#
# So this is a clean room: install the packed tarball globally, unzip the real .mcpb, and run
# the server the way the manifest says to, with no AWM_PACKAGE_ROOT and no source tree.
#
# It does NOT install Claude Desktop. Desktop has a Linux build, but installing an extension
# is a GUI action; what is verified here is everything the GUI would invoke.
set -u
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
chk() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

echo "############ 1. a machine with no AWM source on it ############"
chk "no /src checkout mounted"        "! test -d /src"
echo "  node $(node --version)  $(uname -sm)"

echo
echo "############ 2. install the package globally, as a user would ############"
# From the packed tarball rather than the registry: the registry is behind this build, and a
# test that silently exercised an older published version would be worse than no test.
npm install -g /tmp/awm.tgz --loglevel=error >/tmp/install.log 2>&1
if [ $? -ne 0 ]; then echo "  install FAILED:"; tail -20 /tmp/install.log; exit 1; fi
GLOBAL_ROOT="$(npm root -g)"
echo "  global root : $GLOBAL_ROOT"
chk "package present in the global root"  "test -f \"$GLOBAL_ROOT/agent-working-memory/dist/mcp.js\""

echo
echo "############ 3. unpack the real .mcpb ############"
mkdir -p /ext
# node:22-bookworm-slim ships neither unzip nor python3 — the same "the base image does not
# have that" trap that made the release test's health probes silently return empty. Node's
# own zlib is always present, so extract with that and depend on nothing.
cat > /tmp/unzip.cjs <<'UNZIP'
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { inflateRawSync } = require('node:zlib');
const [src, dest] = process.argv.slice(2);
const b = readFileSync(src);
let e = b.length - 22;
while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
if (e < 0) { console.error('not a zip'); process.exit(1); }
const n = b.readUInt16LE(e + 10);
let off = b.readUInt32LE(e + 16);
for (let i = 0; i < n; i++) {
  const nl = b.readUInt16LE(off + 28), el = b.readUInt16LE(off + 30), cl = b.readUInt16LE(off + 32);
  const method = b.readUInt16LE(off + 10), size = b.readUInt32LE(off + 20);
  const lo = b.readUInt32LE(off + 42);
  const name = b.toString('utf8', off + 46, off + 46 + nl);
  off += 46 + nl + el + cl;
  if (name.endsWith('/')) continue;
  const ln = b.readUInt16LE(lo + 26), le = b.readUInt16LE(lo + 28);
  const start = lo + 30 + ln + le;
  const raw = b.subarray(start, start + size);
  const out = join(dest, name);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, method === 0 ? raw : inflateRawSync(raw));
}
UNZIP
node /tmp/unzip.cjs /tmp/ext.mcpb /ext

echo "  contents: $(find /ext -type f | sed 's|/ext/||' | tr '\n' ' ')"
chk "manifest.json unpacked"          "test -f /ext/manifest.json"
ENTRY=$(node -e "console.log(require('/ext/manifest.json').server.entry_point)")
chk "entry_point unpacked: $ENTRY"    "test -f \"/ext/$ENTRY\""

echo
echo "############ 4. build the launch exactly as the manifest specifies ############"
# Expand ${__dirname} and ${user_config.*} the way Claude Desktop does. AWM_PACKAGE_ROOT is
# deliberately EMPTY — the whole point is that the launcher must find the global install.
node -e '
const m = require("/ext/manifest.json");
const vars = {
  "__dirname": "/ext",
  "HOME": process.env.HOME,
  "user_config.db_path": "/data/desktop-store.db",
  "user_config.agent_id": "personal",
  "user_config.package_root": "",
};
const exp = s => { let o = s; for (const [k,v] of Object.entries(vars)) o = o.split("${"+k+"}").join(v); return o; };
const cfg = m.server.mcp_config;
const out = {
  command: cfg.command,
  args: cfg.args.map(exp),
  env: Object.fromEntries(Object.entries(cfg.env).map(([k,v]) => [k, exp(v)])),
};
require("fs").writeFileSync("/tmp/launch.json", JSON.stringify(out, null, 2));
console.log("  command : " + out.command + " " + out.args.join(" "));
console.log("  db      : " + out.env.AWM_DB_PATH);
console.log("  surface : " + out.env.AWM_SURFACE);
console.log("  pkgroot : " + JSON.stringify(out.env.AWM_PACKAGE_ROOT) + "   <- empty on purpose");
'
mkdir -p /data

echo
echo "############ 5. the server the manifest starts, on a machine with no checkout ############"
cat > /tmp/drive.cjs <<'DRIVE'
const { spawn } = require('node:child_process');
const cfg = require('/tmp/launch.json');
const env = { ...process.env, ...cfg.env, AWM_HOOK_PORT: '18900', AWM_HOOK_PORT_RANGE: '4' };
const child = spawn(cfg.command, cfg.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', err = '';
child.stderr.on('data', d => { err += d; });
const pending = new Map(); let id = 0;
const call = (method, params) => new Promise((res, rej) => {
  const i = ++id;
  const t = setTimeout(() => rej(new Error(method + ' timed out\n' + err.slice(-800))), 120000);
  pending.set(i, v => { clearTimeout(t); res(v); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
});
child.stdout.on('data', d => {
  buf += d;
  const lines = buf.split('\n'); buf = lines.pop() ?? '';
  for (const l of lines) { if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; }
    const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } }
});
(async () => {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'docker', version: '1' } });
  console.log('SERVER=' + (init.result?.serverInfo?.name ?? '?') + '@' + (init.result?.serverInfo?.version ?? '?'));
  const tools = await call('tools/list', {});
  console.log('TOOLS=' + (tools.result?.tools ?? []).length);
  const w = await call('tools/call', { name: 'memory_write', arguments: {
    concept: 'Docker clean-room desktop probe DESKTOPCLEANROOM1',
    content: 'Written through the .mcpb manifest on a machine with no AWM checkout, resolving the globally installed package. DESKTOPCLEANROOM1.',
    project: 'AWM', topic: 'desktop-cleanroom', intent: 'finding', confidence_level: 'verified', memory_class: 'canonical',
  }});
  console.log('WROTE=' + ((w.result?.content ?? []).map(c => c.text ?? '').join(' ').slice(0, 60)));
  const r = await call('tools/call', { name: 'memory_recall', arguments: { query: 'DESKTOPCLEANROOM1 clean-room desktop probe', limit: 5 } });
  const text = (r.result?.content ?? []).map(c => c.text ?? '').join('\n');
  console.log('RECALLED=' + (text.includes('DESKTOPCLEANROOM1') ? 'yes' : 'no'));
  child.kill();
  process.exit(0);
})().catch(e => { console.log('DRIVE_ERROR=' + e.message); child.kill(); process.exit(1); });
DRIVE
node /tmp/drive.cjs > /tmp/drive.out 2>/tmp/drive.err
sed 's/^/    /' /tmp/drive.out

SERVER=$(grep -oP 'SERVER=\K.*' /tmp/drive.out 2>/dev/null)
TOOLS=$(grep -oP 'TOOLS=\K[0-9]+' /tmp/drive.out 2>/dev/null)
chk "the launcher found the GLOBAL install (no checkout)" "[ -n \"$SERVER\" ]"
chk "server identifies itself: $SERVER"                   "echo \"$SERVER\" | grep -q agent-working-memory"
chk "serves all 19 tools (got ${TOOLS:-0})"               "[ \"${TOOLS:-0}\" -ge 19 ]"
chk "a write through the manifest succeeded"              "grep -q 'WROTE=.*\(Stored\|active\|staging\)' /tmp/drive.out"
chk "and is recalled back"                                "grep -q 'RECALLED=yes' /tmp/drive.out"

echo
echo "############ 6. the store is a SQLite FILE, not a PGlite directory ############"
# The 0.15.2 bug: a new store at an explicit path inherited its backend from the cwd.
chk "AWM_DB_PATH is a file"            "test -f /data/desktop-store.db"
chk "AWM_DB_PATH is NOT a directory"   "! test -d /data/desktop-store.db"

echo
echo "############ 7. provenance recorded ############"
node -e "
try {
  const p = require('$GLOBAL_ROOT/agent-working-memory/node_modules/better-sqlite3');
  const db = p('/data/desktop-store.db');
  const rows = db.prepare(\"SELECT tags FROM engrams WHERE concept LIKE '%DESKTOPCLEANROOM1%'\").all();
  console.log('    rows: ' + rows.length + '  tags: ' + (rows[0] ? rows[0].tags : '-'));
  db.close();
} catch (e) { console.log('    sqlite check skipped: ' + e.message.slice(0, 80)); }
"
chk "write carries surface=claude-desktop" "node -e \"const p=require('$GLOBAL_ROOT/agent-working-memory/node_modules/better-sqlite3');const db=p('/data/desktop-store.db');const r=db.prepare(\\\"SELECT tags FROM engrams WHERE concept LIKE '%DESKTOPCLEANROOM1%'\\\").get();db.close();process.exit(r&&String(r.tags).includes('surface=claude-desktop')?0:1)\""

echo
echo "================ RESULT: $PASS passed, $FAIL failed ================"
if [ "$FAIL" -ne 0 ]; then echo; echo "--- launcher stderr (tail) ---"; tail -25 /tmp/drive.err 2>/dev/null; fi
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
