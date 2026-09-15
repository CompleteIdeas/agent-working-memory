# Releasing AWM

Every release before 0.14.6 shipped, then needed a follow-up commit for one thing that got
forgotten. The pattern is always the same: a fact about the system is written down in more
than one place, and only one copy gets updated.

So this document is short on purpose, and half of it is automated:

```bash
npm run check:release
```

That catches the mechanical half — version strings that disagree, counts the docs assert
about the code, the setup adapter falling behind the engine. It runs automatically before
`npm publish`, and a blocking issue stops the publish. **What follows is only the part a
machine cannot check.**

---

## Before you start: what kind of change is this?

Do not read the whole list. Find the rows that match what you actually changed.

| If you changed… | You must also update |
|---|---|
| **A default, threshold or env var** | `docs/reference.md` (the authoritative list), the generated guidance in `src/adapters/common.ts` if an agent needs to know, and any doc that *quotes the number* — `check:release` prints the blast radius |
| **The recall or write pipeline** | `docs/pipeline-walkthrough.html` if the mental model changed, not just the numbers. Re-run the benchmark and follow the "benchmark numbers" row below |
| **A benchmark number** | Do not hand-edit it. Run `npm run bench`, which regenerates `docs/benchmarks-current.md` stamped with version, commit and snapshot. Then update every doc `check:release` lists under `benchmark-spread`, in the same commit. This is the single most common miss |
| **Anything the MCP server exposes** | Tool count claims (checked), `docs/reference.md`, and the tool descriptions themselves — those are prompts, and agents act on them |
| **Hook behaviour, ports, or the sidecar** | `src/adapters/hook-scripts.ts` **and** `AWM_HOOKS_VERSION`, `tests/adapters/hook-scripts.test.ts`, `docs/reference.md` hook section, `docs/claude-code-setup.md` |
| **Anything that changes what a FRESH install should look like** | `src/adapters/` — see the box below. This is the one that cost a whole release |
| **A claim in the README** | Check it is still true. The README is the most-read and least-verified file in the repo |
| **Anything a user has to re-run to get your change** | Say so, and say it is not automatic if it is not. A marketplace installed from a local directory never refreshes on its own — measured: one on this machine had not moved in 167 days — so `npm update` alone leaves the old hooks and skill in place while the server runs new code |
| **A version number inside a test** | Derive it, do not write it. `tests/docker/release-test.sh` asserted `/health` returned `0.14.6`; it went stale immediately and only failed three releases later, where it read as a product bug rather than a rotting assertion |
| **A new npm script** | The script block in `README.md`, the Releasing section in `CONTRIBUTING.md`, and the Verify list below. A script nobody can find is a script nobody runs |
| **A new doc, or a generated one** | `docs/README.md` — it is the index, and an unindexed page is invisible. Say plainly whether the page is hand-written or generated |
| **`src/plugin/awm-mcp-launcher.cjs`** | `npm run build:plugin` **and** `npm run build:mcpb` — both surfaces ship the same launcher, and both are drift-gated |
| **Anything under `src/adapters/`** | `npm run build && npm run build:plugin`, and commit `plugin/`. It is generated from those modules, so a change there silently makes the shipped plugin wrong. `check:release` blocks on the drift |
| **A new top-level directory** | The staging list in `tests/docker/linux-suite.sh`. It is an explicit allowlist, so a new directory is silently absent inside the container and its tests are skipped rather than failed. `plugin/` hit exactly this |
| **Any `.sh` or `.cjs` read by a container** | Nothing — `.gitattributes` pins them to LF. Do not remove those rules: `core.autocrlf=true` is normal on a Windows checkout, and a CRLF shell script fails inside Linux as `set: -: invalid option`, which reads as a broken test |

> ### The row that gets violated most
>
> **A default, threshold or env var → `docs/reference.md`.** Audited before the 0.14.6 push,
> that row had been missed for four releases: `AWM_HOOK_PORT_RANGE` (added 0.14.2) and
> `AWM_SETUP_HOME` (added 0.14.6) were undocumented, and worse, the page still instructed
> readers to *"give each a different `AWM_HOOK_PORT`"* — manual work that port walking had
> made unnecessary three releases earlier. Stale instructions cost more than missing ones,
> because someone follows them.
>
> The same audit found `docs/claude-code-setup.md` last touched 2026-08-22, describing
> inline-`curl` hooks and a `data/.awm-hook-secret` file that 0.14.6 replaced. It is named
> in the hooks row above and was missed anyway. **Grep the docs for the thing you changed
> before you tag; the table only helps if someone reads it.**

> ### The 0.14.6 lesson, stated once
>
> Releases 0.14.2 through 0.14.5 changed how AWM is invoked — port ranges, feedback ids,
> abstention defaults — and **not one of them touched `src/adapters/`**. So a fresh
> `awm setup --global` kept installing 0.14.1-era wiring: hooks hardcoded to one port, no
> prime hook at all, guidance that never mentioned `recall_id`. The engine was four
> releases ahead of its own installer and nothing said so.
>
> After any behaviour change, ask one question: **if someone installed this today, from
> scratch, would they get the thing I just built?** `check:release` warns when engine code
> moved and the adapters did not, but it cannot answer the question for you.

---

## The release

### 1. Verify

```bash
npx tsc --noEmit -p .      # typecheck
npx vitest run             # full suite — put the real number in the README
npm run test:mcp           # MCP smoke test against a live server
npm run check:release      # the mechanical half of this document
npm run test:linux         # build + full suite on Linux (see below)
npm run test:docker        # clean-room install of the packed tarball (see below)
```

If anything touched retrieval, also regenerate the measured numbers rather than editing
them:

```bash
npm run bench              # identifier, category and temporal fixtures
npm run bench -- --all     # plus the local challenge suites
```

It refuses to start below 8 GB of commit headroom, because these suites load ONNX models
natively and five earlier runs were OOM-killed on this machine, one of them mid-write
(`BENCH_MIN_HEADROOM_GB` overrides it). It
writes `docs/benchmarks-current.md` and archives raw stdout under `bench-runs/`.

**`--all` needs a live server.** The four local suites (self, edge, stress, sleep) drive
`http://localhost:8400` and do not start one; without it they exit 1 in about ten seconds and
were reported as FAILED — a missing precondition dressed up as a broken product. They are now
probed for and skipped with the reason. To actually run them, start a server against a
**scratch database** first, never your real store, because these suites seed and mutate data:

```bash
AWM_DB_PATH=/tmp/bench-scratch.db npm start
```

Commit before you measure: a dirty tree stamps the generated page
*"not a releasable measurement"*. Anything
it cannot regenerate — the gauntlet, the production cost audit, retired LoCoMo — is listed
in its own output as historical rather than quietly carried forward.

**A number without a version, a commit and a snapshot behind it is a rumour.** That is how
`benchmarks.md` came to hold results from five app versions measured by three instruments,
two of which were later found defective.

If the setup path, the hooks, or the installed guidance changed, validate the artifact the
way a **new** user receives it:

```bash
npm run test:docker        # packs the real tarball, installs it into an empty container
```

24 assertions, about two minutes, nothing touching the host's store or config. It covers
what no test on a configured developer machine can: a global install from the packed
tarball, `awm setup` writing hooks and guidance from nothing, two servers both preferring
port 8401 where the second **walks to 8402** instead of giving up, each shipped hook
routing to the sidecar for its own agent, the prime off-switch, and `awm doctor` seeing
both sidecars. Run it before tagging. It is also the only way to check the release when
you are away from the machine, since it needs no session restart.

That one installs the **Windows-built** `dist/`, so it proves the artifact runs on Linux
but not that the code *builds* there, and it only loads the import graph that startup,
setup and one recall happen to touch. The other mode closes that:

```bash
npm run test:linux         # compiles from source in Linux, runs all 65 test files there
```

Windows resolves a wrong-cased import happily and `tsc` never sees the conflict, so
`forceConsistentCasingInFileNames` in `tsconfig.json` is not actually enforced by anything
until a case-sensitive filesystem runs it. This is also the only check that loads PGlite,
the coordination layer and the export/import CLI paths off Windows. About ten minutes.

**This capability already existed once and was lost.** Docker images `awm-linux-test:0.13.1`
through `:v0133`, built 2026-08-23, copy `src/` and `tests/` into `node:22-bookworm-slim` and
carry `CMD ["npm","run","test:run"]` over a 0.13.3 `package.json` — images built to do exactly
this. (They prove the recipe existed, not that anyone ran it or that it passed; only the images
survive.) The Dockerfile that built them was never committed. There is no CI in this repo, so once
that throwaway recipe was gone the check simply stopped happening, and nothing reported its
absence. That is this document's own failure mode wearing a different hat: a capability
that lives in one person's shell history is not a capability. Hence a committed script
and an `npm run` entry rather than a Dockerfile someone rebuilds from memory.

Two things it does on purpose, both learned the hard way:

- The repo is mounted **read-only** and staged to a container-local copy. Running `npm ci`
  against the host checkout would replace `node_modules` with linux-x64 `better-sqlite3`
  and `onnxruntime` binaries and leave you unable to run `tsc` or `vitest` on Windows
  until a full reinstall.
- The model cache is mirrored as a symlink farm rather than mounted read-only.
  transformers.js writes lock files and `.no_exist` markers next to the weights; across
  65 files a read-only `HF_HOME` produces failures that read like model bugs.

It reports `OOMKilled` from `docker inspect` before you read any failure, because a
container OOM presents as a test failure, not as an OOM.

A green run stamps `.release-checks/linux-<version>.json` (gitignored) with the file and
test counts, the commit and the date, and `check:release` reports it — or says no Linux run
is recorded for this version, and says so again if the stamp predates `HEAD`. That note is
never blocking: the stamp is a local artifact and a fresh clone has none. It exists because
the whole reason this check lapsed after 0.13.3 is that nothing anywhere recorded whether it
had run.

Then, if you want to see what an upgrade does to an existing install, rehearse one against
a scratch home:

```bash
AWM_SETUP_HOME=/tmp/scratch-home node dist/cli.js setup claude-code --global --db-path /tmp/scratch.db
AWM_SETUP_HOME=/tmp/scratch-home node dist/cli.js doctor claude-code
```

Seed that scratch home with *copies of a real config* first. A greenfield install passes
trivially; the interesting failures are all in the upgrade path — dropped env values,
deleted user hooks, a repointed database. Two notes from doing this:

- Put the scratch project **outside** your home directory, or give it its own `.mcp.json`.
  The hook finder walks up from the project directory and will reach your real
  `~/.mcp.json` before any scratch fallback.
- Drive the installed hooks against a real `dist/mcp.js` sidecar, with `AWM_HOOK_DEBUG=1`.
  Unit tests use fake sidecars; only the real one proves the checkpoint persisted and that
  `SessionEnd` triggered consolidation.

### 2. Sweep the docs for what your change made untrue

`check:release` compares numbers across files. It cannot tell you that a sentence is now
false. Before tagging, grep the whole doc set for the behaviour you changed — not just the
files the table names — because the expensive failures are **stale instructions**, not
missing ones. A doc that omits a feature costs a reader nothing; a doc that tells them to do
work the release automated costs them an afternoon.

```bash
# Whatever you changed, find every place that still describes the old behaviour.
grep -rn "<old flag, port, file name, default>" README.md docs/ --include=*.md --include=*.html
```

Found by exactly this sweep before the 0.14.6 push, after `check:release` came back clean:

- `docs/reference.md` told readers to "give each a different `AWM_HOOK_PORT`" — manual work
  that port walking removed in 0.14.2.
- `docs/team-setup-guide.md` still taught teams to hand-write inline-`curl` hooks with a
  pasted secret: the exact configuration 0.14.6 exists to replace.
- `docs/troubleshooting.md` suggested `AWM_PORT=8401` to escape a port clash — which lands
  the API on the sidecar's own default and creates a new one.

None of those were caught by a version string or a count. Budget twenty minutes for this.

### 3. Write the CHANGELOG entry first, then the README

Write the CHANGELOG entry **before** touching anything else. It forces you to say what
changed, and the list of things you had to describe is the list of docs that need editing.

The house style, worth keeping: a heading that states the finding rather than the area
(`the eval queried as the wrong agent; the real identifier baseline is 92.7%`), then the
evidence, then what changed. A reader should be able to tell whether the engine moved or
only the instrument did.

Then the README, which has three places carrying a version and one carrying a test count.
All four are checked.

### 4. Version and publish

```bash
# package.json version, then:
npm run check:release      # must be clean
git commit
git tag vX.Y.Z
git push && git push --tags
npm publish                # runs build + check:release again
```

`docs/` is **not** in `package.json` files[], so it never reaches npm. The documentation
site only updates on a git push. If you publish without pushing, the package is new and
every doc link still describes the old release.

### 5. After the tag

- **Consumers that vendor this package.** `AgentSynapse/packages/awm` is a separate
  checkout, not a live dependency. `check:release` reports its version; bump it
  deliberately or leave it pinned deliberately, but decide rather than forget.
- **Your own machine does not upgrade itself.** A running MCP connection keeps the code it
  loaded at spawn time, so a rebuild changes nothing until a fresh session starts. And the
  installed hooks and config only change when you actually run `awm setup`. `memory_whoami`
  reports what a live session is really running.

---

## Why each automated check exists

Not to be exhaustive — so that a check that starts crying wolf can be deleted by someone who
knows what it was for. A gate nobody believes is worse than no gate.

| Check | The failure it is remembering |
|---|---|
| `changelog`, `readme` | The version was bumped in `package.json` and nowhere else, or the What's-new body was rewritten while its heading kept the old version |
| `hooks-version` | A shipped hook script changed without bumping its stamp, so `awm doctor` reports every install as current |
| `tool-count` | A tool was added and six docs kept saying nineteen |
| `test-count` | The README said 737 for three releases |
| `adapter-drift` | The 0.14.6 lesson above |
| `guidance-labels` | The CLAUDE.md text installed on user machines carried `0.8.x` and `0.11.x` labels years after those releases |
| `benchmark-spread` | A corrected benchmark figure has to change in six documents at once, and twice it did not |
| `publish-surface` | `files[]` listing a directory that a clean checkout does not have |
| `linux-suite` | Linux testing existed at 0.13.3, lived only in an uncommitted Dockerfile, and lapsed for four releases with nothing reporting its absence |

---

## What is deliberately not automated

- **Whether a doc is still true.** A file can be internally consistent and describe a system
  that no longer exists. `docs/known-limitations.md` once listed eight limitations that had
  all been fixed.
- **Whether the tool descriptions still read well.** They are prompts. Agents act on them.
- **Whether the mental model changed.** If the *reason* something works is now different,
  the explanatory docs need rewriting, and no diff of numbers will tell you that.
