# awm-learn — teach the agent a whole project in one command

A memory store starts empty, and an empty store is the weakest part of any memory system:
for the first days recall only knows what the agent happened to write down. `awm-learn`
closes that gap. Point it at a repo or a folder, and the agent reads it the way a careful new
hire would, map first, then each part in turn, and writes what it learns into AWM. That covers
code, a manuscript, a docs tree or a data folder. A run can stop and resume, be split across
several agents, and later refresh only what changed.

```
/awm-learn
```

That is the whole interface. It asks at most four questions (what the folder is and what memory
should get good at, the project name, anything off limits, and how much to spend), shows the
price, and starts once you agree.

## How you get it

- **`awm setup --global`** installs it into `~/.claude/skills/awm-learn/` (0.22.2). A re-run
  upgrades a copy setup installed and leaves alone one you edited.
- **The Claude Code plugin** ships it alongside the `awm-memory` skill.
- The installed agent guidance tells the agent when to reach for it: a new project, or one
  whose recall keeps missing.

It needs the AWM tools and Node.js 18 or newer. Nothing else: the planning is done by a
model-free script, and the reading is done by the agent you already run. AWM itself still
calls no hosted model.

## What it does

1. **Plans and prices the run before reading anything.** `scripts/ledger.mjs` lists the files
   (through `git ls-files` in a repo). It skips dependencies, build output, lockfiles, binaries
   and secrets (`.env`, keys, credentials), then groups the rest into units of about 48 KB. Very
   large files are cut at their own section banners or headings, and flat folders are grouped by
   file-name family. Each unit gets a depth: read in full, skimmed, or sampled for its shape. The
   plan is ranked so that entry points and the most-changed files come first, and it is priced
   in tokens. Planning takes about a second: the AWM repo plans as 493 files in 146 units.
2. **Writes the map first:** an overview, where things live, how to run it, and a glossary. That
   makes recall useful before a single unit is read.
3. **Learns each unit:** 0–8 memories per unit, each leading with the fact, naming real
   identifiers, and carrying the natural questions someone would ask for it. Before writing, it
   recalls, so a rule that shows up in both the code and its tests becomes one memory rather
   than two.
4. **Draws the connections** no single file shows: end-to-end flows, architecture, how-tos,
   gotchas.
5. **Tests its own recall.** It asks 20 questions in a newcomer's words, reports the hit rate,
   and rewrites the memories that missed.
6. **Asks you only what the files can't answer,** such as which of two payment paths is current,
   and writes your answers down as decisions.

The ledger lives outside your project, in `~/.awm/learn/<project>/`. It is the record of
coverage: an area counts as learned only when its units are marked done. Claims expire after
two hours, so a crashed agent's units go back in the queue.

## Measured: the first full run

On 2026-11-04 it learned a production club-management API: 374 files, about 260 of them test
files, in 97 units (34 read in full, 63 skimmed).

| | |
|---|---|
| Wall clock | **About 10 minutes**, with 5 agents sharing one ledger |
| Memories written | **344**, all active: 128 on test coverage, 80 modules, 58 gotchas, 33 flows, 29 decisions, 12 how-tos, 4 map |
| Self-test | **12 of 20** newcomer questions answered in the top 3, 6 of 20 first |
| Tokens | About **1.55M**, against a planned 630k |
| Refresh afterwards | Re-hashes every file in seconds; queues only the units that changed |

Along the way it collected the open questions it could not settle from the code, such as two
places that each looked like the source of truth, and handed them to the owner rather than
guessing. Each became a decision to make, not a memory stated as fact.

**What that run says honestly:**
- **12 of 20 is short of the skill's own 80% target.** The misses came mainly from duplicates,
  where the code and its tests stated the same rule in two memories that then outranked each
  other. Since that run the skill recalls before every write and merges instead of adding.
  It has not been re-measured since.
- **Treat the token estimate as a floor.** The run used about 2.5 times the plan. On a large
  repo, skim first and deepen the areas people actually ask about.
- It is one run, on one codebase, by the skill's author.

## Keeping it current

Run `/awm-learn` again after a big merge or a release. With a ledger in place it is a refresh:
changed units are re-learned first, with their old memories superseded rather than duplicated;
new units are learned; and memories from removed files are retracted. The `schedule` or `loop`
skills can run it on a timer.

## Limits

- **It reads what the agent reads.** The quality of the memories is the quality of the model
  doing the reading, and the token cost is that model's.
- **It writes at most 8 memories per unit**, so a 1,000-unit repo comes to roughly 2–4k
  memories, not 20k. Recall gets noisier as near-duplicates pile up, so the cap is deliberate.
- **Personal data is described by its structure only,** unless the owner explicitly asks for
  the contents. Secret values are never written; the variable names are.

The skill itself, with every rule it follows, is
[`skills/awm-learn/SKILL.md`](../skills/awm-learn/SKILL.md).
