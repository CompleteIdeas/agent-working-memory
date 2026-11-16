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

It needs the AWM tools — which means Node.js 22 or newer, since AWM itself requires 22 (the
skill's own ledger script would run on Node 18+). Nothing else: the planning is done by a
model-free script, and the reading is done by the agent you already run. AWM itself still
calls no hosted model.

## What it does

1. **Surveys the corpus first: what is this?** In about a second, with no model, it gives every
   file a role and an authority, which is how far that file's statements should be trusted
   against another's. The roles are source, test, migration, decision record, requirement,
   minutes, policy, plan, changelog, reference, guide and chapter. It also finds each file's
   dates (git history, and any date written in its name or text) and the lines where decisions
   are written down: comments that give a reason or cite a ticket, and "Decision:", "Action:"
   and "Status:" lines in documents. It counts PDFs and Word files as documents to read. It
   holds back anything that looks personal or confidential until you say otherwise. The survey
   turns the first question into a confirmation: "this looks like a code repo with 68
   migrations, 263 test files and no decision records, right?"
2. **Plans and prices the run before reading anything.** `scripts/ledger.mjs` lists the files
   (through `git ls-files` in a repo). It skips dependencies, build output, lockfiles, binaries
   and secrets (`.env`, keys, credentials), then groups the rest into units of about 48 KB. Very
   large files are cut at their own section banners or headings, and flat folders are grouped by
   file-name family. Each unit gets a depth: read in full, skimmed, or sampled for its shape. The
   plan is ranked so that entry points and what records decisions come first, and superseded or
   archived material comes last. It is priced in tokens, including each unit's overhead. Dated
   minutes and decision records can be learned oldest first (`--order chronological`), so a
   later decision supersedes an earlier one when the run reaches it, the way it happened.
3. **Writes the map first:** an overview, where things live, how to run it, which documents are
   the sources of truth, and a glossary that maps the words on the screen ("Paperwork") to the
   words in the code (`clearance_record`). That makes recall useful before a single unit is read.
4. **Learns each unit with its role's playbook.** It reads the decision lines first, with the
   commit subjects that explain recent changes. Requirements keep their ids; minutes become
   decisions and action items dated to the meeting; plans are marked as proposals, not facts;
   tests are folded into the module they test. Each memory states one fact, its title starts
   with the product's name, it leads with the fact, names real identifiers, and carries the
   natural questions someone would ask for it.
5. **Reconciles with what memory already holds.** Before writing, it recalls across the whole
   project. A fact already stated is merged rather than duplicated. A fact the files now
   contradict is corrected. When two sources disagree it ranks them by your word first, then
   authority, then date. When the code and a spec disagree, it records the disagreement as a
   finding instead of picking a winner.
6. **Draws the connections** no single file shows: end-to-end flows, architecture, the timeline
   of each decision, how-tos, gotchas, and a sweep that merges near-duplicates.
7. **Tests its own recall.** It asks 20 questions in a newcomer's words and scores whether a
   correct answer comes back, then names the cause of each miss (vocabulary, duplicate,
   outranked, missing) and fixes it.
8. **Asks you only what the files can't answer,** such as which of two payment paths is current,
   or where the spec and the code disagree, and writes your answers down as decisions.

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
| Self-test | **17 of 20** newcomer questions answered correctly in the top 3, re-measured the same day. The exact memory picked for each question came back for 12–14 of 20 |
| Tokens | About **1.55M**, against a planned 630k |
| Refresh afterwards | Re-hashes every file in seconds; queues only the units that changed |

Along the way it collected the open questions it could not settle from the code, such as two
places that each looked like the source of truth, and handed them to the owner rather than
guessing. Each became a decision to make, not a memory stated as fact.

**What that run says honestly, and what changed because of it:**
- **The first self-test under-reported.** It counted a hit only when the one memory it had
  picked came back, so 12 of 20. Re-run question by question, 17 of 20 got a correct answer in
  the top 3, often from an older memory or a near-duplicate. The self-test now scores both
  numbers.
- **The three real misses were all vocabulary.** The questions used the words on the screen
  ("history of changes", "uploaded paperwork"), and the memories used the words in the code
  (`audit_log`, "submitted requirements"). The map's glossary now pairs the two.
- **It competed with the store instead of joining it.** The store already held 711 memories
  about that project, and 128 of the new ones were test memories restating rules their modules
  already stated. The skill now reconciles across the whole project before writing, and folds
  tests into the module they test.
- **The token estimate ran 2.5 times low.** It counted reading and writing but not each unit's
  overhead: the agent's running context, recalls and tool round-trips, about 9.5k tokens a unit.
  The estimate now includes that, and `done --tokens` records the real cost so the next run's
  price is calibrated. Short worker sessions keep the overhead down.

## Measured: the same repo learned again with the new skill

The same day, the new skill learned the same repo from scratch. It ran three times, and each
run found something to fix before the next. Each run worked on a copy of the store, with the
first run's memories set aside so they could not count for it. Every run is compared with the
first one on two question sets, scored by judges who did not know which run gave which answers:

- **20 original questions.** These were written from the first run's own memories, so they
  favour it.
- **30 fresh questions.** An agent that had seen neither run wrote these from the code. They
  are the fair test.

Each set was asked twice: once with the product's name in the question, once without. A
question counts as answered when a correct memory comes back in the top 3. The judges vary by
about ±2.

| Question set | First run | Re-run 1 | Re-run 2 | Re-run 3 |
|---|---|---|---|---|
| 30 fresh, no product name | 20 (15 first) | 17 | 21 | **22 (19 first)** |
| 30 fresh, with the name | 24 (18 first) | 14 | 20 | **24 (17 first)** |
| 20 original, no product name | 12–14 | 10 | 11 | **12** |
| 20 original, with the name | 17 | 5 | 11 | **16** |

**What each re-run taught:**
- **Re-run 1 did worse.** Only 16 of its 158 memory titles named the product, so questions that
  used the name found older notes instead. It also counted older notes as coverage, wrote
  fewer memories, and skipped 14 units. The skill now puts the product's name at the front of
  every title, and counts only the run's own memories as coverage.
- **Re-run 2 merged too much.** Told to reconcile, it grew one memory per area instead of one per
  fact: median 1,181 characters, and 55 memories over 1,500. Long memories rank worse because
  each one is about too many things. The skill now writes one fact per memory, about 500–1,000
  characters, and supersedes an existing memory only when it states the same fact.
- **Re-run 3 matches the first run and puts the right answer first more often.** It wrote 437
  memories (median 830 characters, one over 1,500), and every title names the product. It
  corrected older notes the code had since overtaken. The gap is within the judges' noise, so
  this is a match, not a proven win.

| Re-run 3 | |
|---|---|
| Memories | **437**, one fact each, median 830 characters |
| Tokens | About **1.80M**, against an estimate of 1.31M (1.37×; the first run was 2.5×) |
| Interruptions | A usage limit stopped all 5 workers partway; they resumed from the ledger and no unit was lost |

The re-runs also found two bugs in AWM itself. A write close to an existing memory is merged
into it and returns that memory's id; superseding the old memory with that id made the memory
supersede itself, and it vanished from recall. AWM now ignores a supersede from a memory to
itself (0.22.3). And a slice of a very large file was named after a heading found inside the
slice, not the section it starts in, so it was named after the wrong section.

It is still one codebase, measured by the skill's author.

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
