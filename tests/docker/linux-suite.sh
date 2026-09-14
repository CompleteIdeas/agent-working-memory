#!/usr/bin/env bash
# Runs INSIDE a clean node:22 container.  `npm run test:docker -- linux`
#
# WHY THIS EXISTS
# ---------------
# The release test (release-test.sh) installs the WINDOWS-BUILT dist/ into a Linux
# container. That proves the artifact runs on Linux; it does not prove the code BUILDS
# on Linux, and it exercises only the import graph that startup + setup + one recall
# happen to touch. PGlite, Postgres, coordination, consolidation and the export/import
# CLI paths had never been loaded on a case-sensitive filesystem.
#
# This compiles from source and runs the whole unit suite on Linux.
#
# The repo is mounted READ-ONLY at /src on purpose: running `npm ci` against the host
# checkout would replace its node_modules with linux-x64 better-sqlite3 / onnxruntime
# binaries and leave the developer unable to run tsc or vitest until a full Windows
# reinstall. Everything happens in a container-local copy.
set -u
cd /

echo "############ 1. stage a writable copy of the source ############"
mkdir -p /app
# A DENY list, not an allow list. The allow list rotted three times — plugin/ and
# .claude-plugin/ first, then mcpb/ and scripts/ — and each time the symptom was tests
# SKIPPED rather than failed, which reads as success at a glance. Anything new at the top
# level is now staged automatically; only the things that must not come are named.
#
#   node_modules  Windows-native binaries; npm ci rebuilds them for linux-x64
#   dist          Windows-built output; npx tsc rebuilds it here
#   .git          large and pointless inside the container
#   data          ~1 GB of ONNX models; mounted separately at /models-ro
#   bench-runs    benchmark artefacts
#   .release-*    host-side stamps and staging
for item in /src/* /src/.[!.]*; do
  [ -e "$item" ] || continue
  base=$(basename "$item")
  case "$base" in
    node_modules|dist|.git|data|bench-runs|dist-mcpb|.release-stage|.release-checks) continue ;;
  esac
  cp -r "$item" /app/ 2>/dev/null || true
done

# Sanity: the suite is worthless if the things it tests did not arrive.
MISSING=0
for required in package.json tsconfig.json vitest.config.ts src tests scripts plugin mcpb; do
  if [ ! -e "/app/$required" ]; then echo "  MISSING from /src: $required"; MISSING=1; fi
done
if [ "$MISSING" = 1 ]; then
  echo "  refusing to run a partial checkout — check the deny list in tests/docker/linux-suite.sh"
  exit 1
fi
echo "  staged: $(ls /app | tr '\n' ' ')"
echo "  node $(node --version)  npm $(npm --version)  $(uname -sm)"

echo
echo "############ 2. model cache ############"
# transformers.js writes lock files and .no_exist markers next to the weights, so a
# read-only HF_HOME produces failures that look like model bugs. Mirror the cache as a
# symlink farm: directories are real and writable, weights are symlinks to the read-only
# mount. Costs milliseconds instead of copying ~1GB through a bind mount.
if [ -d /models-ro ]; then
  mkdir -p /models
  ( cd /models-ro && find . -type d -printf '%p\0' | xargs -0 -I{} mkdir -p "/models/{}" )
  ( cd /models-ro && find . -type f -printf '%p\0' | xargs -0 -I{} ln -sf "/models-ro/{}" "/models/{}" )
  export HF_HOME=/models
  echo "  mirrored $(find /models -type l | wc -l) cached files -> writable HF_HOME=/models"
else
  export HF_HOME=/models
  mkdir -p /models
  echo "  no cache mounted; models will download on demand"
fi

echo
echo "############ 3. npm ci (linux-x64 native deps) ############"
cd /app
if ! npm ci --loglevel=error >/tmp/ci.log 2>&1; then
  echo "  npm ci FAILED:"; tail -40 /tmp/ci.log; exit 1
fi
echo "  installed $(ls node_modules | wc -l) packages"
node -e "
for (const m of ['better-sqlite3','onnxruntime-node']) {
  try { require.resolve(m); console.log('  native dep present: '+m); }
  catch { console.log('  native dep MISSING: '+m); }
}" 2>/dev/null

echo
# The cross-surface end-to-end test packs a real .mcpb, so it needs the MCPB CLI. Installing
# it here rather than letting that test skip: a skipped end-to-end test is the one that most
# looks like a pass. It also means the Desktop extension path is exercised on Linux, which
# matters now that Claude Desktop has a Linux build.
echo "############ 3b. MCPB CLI (for the Desktop extension tests) ############"
if npm install -g @anthropic-ai/mcpb --loglevel=error >/tmp/mcpb-cli.log 2>&1; then
  echo "  mcpb $(mcpb --version 2>/dev/null || echo installed)"
else
  echo "  WARNING: mcpb CLI did not install — the .mcpb tests will fail rather than skip"
  tail -5 /tmp/mcpb-cli.log
fi


echo "############ 4. BUILD on a case-sensitive filesystem ############"
# forceConsistentCasingInFileNames is on, but Windows resolves a wrong-cased import
# anyway and tsc never sees the conflict. Linux is where it surfaces.
if npx tsc; then
  echo "  BUILD OK — tsc exit 0, dist/ has $(find dist -name '*.js' | wc -l) js files"
  BUILD_OK=1
else
  echo "  BUILD FAILED on Linux"
  BUILD_OK=0
fi

echo
echo "############ 5. the full unit suite on Linux ############"
echo "  (vitest: pool=forks, maxWorkers=1 — same config as Windows)"
# No --reporter flag: `basic` was removed in vitest 4 and the failure it produces
# ("Failed to load custom Reporter from basic") looks like a suite failure, not a typo.
# NO_COLOR because the summary line is otherwise shot through with escape codes, which
# makes both the saved log and the count-parsing below needlessly fragile.
# Full output — a `tail` here would truncate exactly the failure detail you need. tee'd so
# the counts can be stamped without a second run; PIPESTATUS because tee's exit is not it.
export NO_COLOR=1
npx vitest run 2>&1 | tee /tmp/vitest.log
SUITE=${PIPESTATUS[0]}

# One machine-readable line the host wrapper greps to record that THIS version passed here.
FILES=$(grep -oE 'Test Files +[0-9]+ passed' /tmp/vitest.log | grep -oE '[0-9]+' | head -1)
TESTS=$(grep -oE 'Tests +[0-9]+ passed'      /tmp/vitest.log | grep -oE '[0-9]+' | head -1)

echo
echo "================ LINUX RESULT ================"
echo "  build (tsc):  $([ "$BUILD_OK" = 1 ] && echo PASS || echo FAIL)"
echo "  unit suite :  $([ "$SUITE" = 0 ] && echo PASS || echo "FAIL (exit $SUITE)")"
if [ "$BUILD_OK" = 1 ] && [ "$SUITE" = 0 ]; then
  echo "LINUX_STAMP files=${FILES:-?} tests=${TESTS:-?} node=$(node --version) os=$(uname -s) arch=$(uname -m)"
  exit 0
fi
exit 1
