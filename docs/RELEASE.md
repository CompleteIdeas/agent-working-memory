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
```

If anything touched retrieval, also regenerate the measured numbers rather than editing
them:

```bash
npm run bench              # identifier, category and temporal fixtures
npm run bench -- --all     # plus the local challenge suites
```

It refuses to start below 8 GB of commit headroom, because these suites load ONNX models
natively and five earlier runs were OOM-killed on this machine, one of them mid-write. It
writes `docs/benchmarks-current.md` and archives raw stdout under `bench-runs/`. Anything
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

### 2. Write the CHANGELOG entry first, then the README

Write the CHANGELOG entry **before** touching anything else. It forces you to say what
changed, and the list of things you had to describe is the list of docs that need editing.

The house style, worth keeping: a heading that states the finding rather than the area
(`the eval queried as the wrong agent; the real identifier baseline is 92.7%`), then the
evidence, then what changed. A reader should be able to tell whether the engine moved or
only the instrument did.

Then the README, which has three places carrying a version and one carrying a test count.
All four are checked.

### 3. Version and publish

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

### 4. After the tag

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
