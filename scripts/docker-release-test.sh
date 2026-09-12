#!/usr/bin/env bash
# Clean-room validation in Docker.  `npm run test:docker [release|linux|all]`
#
# WHY THIS EXISTS
# ---------------
# 0.14.6 exists because releases 0.14.2-0.14.5 shipped engine changes while `awm setup`
# kept installing 0.14.1-era wiring. Nothing caught it, because every test ran against a
# developer machine that was already configured.
#
# Two modes, because they answer different questions:
#
#   release  (default)  Packs the real publish artifact and installs it into an empty
#                       container: the path a NEW user takes. Proves port walking (0.14.2),
#                       per-agent hook routing, the prime off-switch, `awm doctor`.
#                       ~2 min. Uses the WINDOWS-BUILT dist/.
#
#   linux               Compiles from source inside Linux and runs the whole unit suite
#                       there. Proves the code BUILDS on a case-sensitive filesystem and
#                       that all 65 test files pass off Windows. ~10 min, and it is the
#                       only check that ever loads PGlite, coordination and the CLI paths
#                       on Linux.
#
#   all                 Both, release first.
#
# Requires Docker. Nothing touches the host's store, config, or node_modules.
set -uo pipefail
MODE="${1:-release}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Git Bash hands POSIX paths to Windows binaries, which then read /tmp as C:\tmp, and it
# rewrites container paths inside `docker run`. Normalise to the mixed form (C:/...) once:
# npm, docker and bash all accept it.
export MSYS_NO_PATHCONV=1
if command -v cygpath >/dev/null 2>&1; then HOST="$(cygpath -m "$ROOT")"; else HOST="$ROOT"; fi

model_mount() { # echoes mount args for the cached models, if present
  local at="$1"
  if [ -d "$ROOT/data/models" ]; then printf -- '-v\n%s/data/models:%s:ro\n' "$HOST" "$at"; fi
}

run_release() {
  local VERSION STAGE HOST_STAGE TGZ
  VERSION=$(node -e "console.log(require('./package.json').version)")
  STAGE="$ROOT/.release-stage"; HOST_STAGE="$HOST/.release-stage"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  trap 'rm -rf "$ROOT/.release-stage"' EXIT

  echo "Packing the real publish artifact (v$VERSION)..."
  npm run build >/dev/null || { echo "build failed"; return 1; }
  TGZ=$(npm pack --pack-destination "$HOST_STAGE" --loglevel=error | tail -1)
  test -f "$STAGE/$TGZ" || { echo "pack produced nothing at $STAGE/$TGZ"; return 1; }
  echo "  $TGZ ($(wc -c < "$STAGE/$TGZ") bytes)"

  local MOUNTS=(-v "$HOST_STAGE/$TGZ:/tmp/awm.tgz:ro" -v "$HOST/tests/docker/release-test.sh:/test.sh:ro")
  # The model cache is ~1GB. Mount it when present so the container does not re-download;
  # without it the test still passes, just slower.
  if [ -d "$ROOT/data/models" ]; then
    MOUNTS+=(-v "$HOST/data/models:/models:ro" -e HF_HOME=/models)
    echo "  mounting cached models"
  fi

  echo "Running clean-room install in node:22-bookworm-slim..."
  docker run --rm --memory=6g --memory-swap=6g "${MOUNTS[@]}" node:22-bookworm-slim bash /test.sh
}

run_linux() {
  # The repo goes in READ-ONLY. `npm ci` inside the container must never reach the host
  # checkout: it would swap node_modules for linux-x64 binaries and break the developer's
  # ability to run tsc or vitest on Windows until a full reinstall.
  local MOUNTS=(-v "$HOST:/src:ro")
  if [ -d "$ROOT/data/models" ]; then
    MOUNTS+=(-v "$HOST/data/models:/models-ro:ro")
    echo "  mounting cached models read-only (mirrored writable inside)"
  fi

  local NAME="awm-linux-suite-$$"
  local OUT="$ROOT/.release-stage/linux-run.log"
  mkdir -p "$ROOT/.release-stage"
  trap 'rm -rf "$ROOT/.release-stage"' EXIT
  echo "Building from source and running the full suite in node:22-bookworm-slim..."
  docker run --name "$NAME" --memory=6g --memory-swap=6g "${MOUNTS[@]}" \
    node:22-bookworm-slim bash /src/tests/docker/linux-suite.sh 2>&1 | tee "$OUT"
  local RC=${PIPESTATUS[0]}

  # A container OOM presents as a test failure, not as an OOM. Check before debugging.
  local OOM
  OOM=$(docker inspect -f '{{.State.OOMKilled}}' "$NAME" 2>/dev/null || echo unknown)
  docker rm -f "$NAME" >/dev/null 2>&1
  if [ "$OOM" = "true" ]; then
    echo
    echo "  *** container was OOM-KILLED (--memory=6g). The failures above are not"
    echo "  *** necessarily real; re-run with a higher cap before investigating them."
    return 1
  fi
  echo "  (OOMKilled: $OOM)"

  # A check nothing records is a check that quietly lapses — which is how the 0.13.3 Linux
  # images came to be the only surviving trace of this test. Stamp the run so
  # `npm run check:release` can report whether the CURRENT version has been through Linux.
  local STAMP VERSION SHA
  STAMP=$(grep -m1 '^LINUX_STAMP ' "$OUT" 2>/dev/null || true)
  if [ "$RC" -eq 0 ] && [ -n "$STAMP" ]; then
    # $ROOT is the Git Bash form (/c/Users/...) — bash understands it, Windows node does not.
    # Relative require works because the script cd's to $ROOT; node WRITES via $HOST.
    VERSION=$(node -e "console.log(require('./package.json').version)")
    SHA=$(git -C "$HOST" rev-parse --short HEAD 2>/dev/null || echo unknown)
    # The run tests the WORKING TREE, not the commit. Record whether they differed, so a
    # stamp taken over uncommitted changes is not mistaken for one taken at that commit.
    [ -n "$(git -C "$HOST" status --porcelain 2>/dev/null)" ] && SHA="$SHA-dirty"
    mkdir -p "$ROOT/.release-checks"
    node -e '
      const [out, version, commit, ...rest] = process.argv.slice(1);
      const kv = Object.fromEntries(rest.filter(p => p.includes("=")).map(p => p.split("=")));
      require("fs").writeFileSync(out,
        JSON.stringify({ version, commit, when: new Date().toISOString(), ...kv }, null, 2) + "\n");
    ' "$HOST/.release-checks/linux-$VERSION.json" "$VERSION" "$SHA" $STAMP
    echo "  recorded: .release-checks/linux-$VERSION.json"
  fi
  return $RC
}

case "$MODE" in
  release) run_release ;;
  linux)   run_linux ;;
  all)     run_release; R=$?; echo; echo "=========================================="; echo;
           run_linux;   L=$?
           echo; echo "release: $([ $R = 0 ] && echo PASS || echo FAIL)   linux: $([ $L = 0 ] && echo PASS || echo FAIL)"
           [ $R = 0 ] && [ $L = 0 ] ;;
  *)       echo "usage: npm run test:docker [-- release|linux|all]"; exit 2 ;;
esac
