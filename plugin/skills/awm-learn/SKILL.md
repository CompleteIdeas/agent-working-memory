---
name: awm-learn
description: >-
  Learn a whole repo or folder into AWM memory — code, a manuscript, a docs tree, a data
  folder, anything — systematically and resumably, so every agent on the team can recall how
  it works and where everything is. Plans the work into units with a ledger, reads the most
  important parts in full and skims the rest within a token budget, writes atomic recall-shaped
  memories with natural questions, synthesises cross-cutting flows, tests its own recall, asks
  the owner only what the files can't answer, and refreshes when files change. Use when someone
  says "awm learn", "learn this repo/folder/book", "onboard AWM onto this project", "study this
  codebase", "teach memory about X", "warm-start memory for this project", or points at a path
  and wants it understood and remembered. Also use to refresh or continue an earlier learn run.
---

# awm learn

Turn a folder into memory that recall can use. You do the reading and the thinking. AWM
stores the result, and `scripts/ledger.mjs` (in this skill's folder) keeps the bookkeeping:
what exists, what has been learned, what changed. The ledger means a giant repo can be learned
across many sessions and by several agents, without repeating work and without missing parts.

**Needs:** the AWM tools (`memory_write`, `memory_recall`, `memory_supersede`, `memory_retract`,
`memory_task_add`, `memory_task_update`). If the MCP server is down, use the HTTP fallback at
`http://127.0.0.1:8400` (`POST /memory/write-batch`, `POST /memory/activate`). Never fall back
to writing Markdown memory files. You also need Node.js 18 or newer for the ledger.

```
L="node <this skill's folder>/scripts/ledger.mjs"      # every ledger command below
$L plan <path> --project NAME      $L next --project NAME --n 3 --agent <you>
$L done <unit> --project NAME --memories N      $L skip <unit> --project NAME --note "why"
$L deepen <unit> --project NAME    $L status --project NAME    $L refresh --project NAME    $L list
```

## 0. Intake (one round, four questions at most)

First run `$L list`. If a ledger already exists for this path, this is a **continue** or
**refresh** run: go to the section "Continue and refresh".

Otherwise, look at the top of the folder (README, manifest, folder names) to guess what it is,
then ask only what you can't tell, with AskUserQuestion:

1. **What is it, and what should memory get good at?** For example: "answer how-does-X-work
   questions about the API", "keep the characters and timeline of my novel straight", "know
   where every policy lives".
2. **The project name** for the `project` field. Suggest one short word.
3. **Anything off limits?** Private data, client folders, drafts, generated output. These go
   into `--exclude` or a `.awmlearnignore` file in the folder.
4. **The budget.** Show the plan's cost (step 1) and offer: the planned depth (recommended),
   skim everything (cheapest), or deeper.

Pick the **profile** from what you see. Mixed folders use several (section "Profiles").

## 1. Plan

```
$L plan <path> --project NAME [--exclude "glob,glob"] [--budget TOKENS]
```

The plan:
- lists every file, using `git ls-files` when the folder is a repo;
- skips dependencies, build output, lockfiles, binaries and **secrets** (`.env`, keys,
  credentials);
- groups the files into **units**: a folder's files, split at about 48 KB, and any large file
  on its own;
- ranks the units: entry points and the top of the tree first, then the most-changed files,
  then size;
- assigns each unit a depth: `deep` (read in full), `skim` (the first ~3 KB of each file) or
  `sample` (data: the first lines only, for the shape).

The default budget is enough to skim everything, plus 300k tokens to read the most important
units in full.

Show the owner the summary lines: files, units, depth split, estimated tokens, what is not read.
**If the estimate is over about 300k tokens, confirm before going on.** Offer to narrow the
scope with `--exclude` or a sub-folder, or to lower `--budget`.

Then create one coordinator task so other sessions can find the run:
`memory_task_add(concept: "awm learn <project>", content: path, ledger, goal, profile, budget)`.

## 2. Map: top-down, before any unit

Read the root files, the manifests and the folder tree (`$L status --json` lists the units).
Write these **map memories** first. They make recall useful immediately, even before a single
unit is learned:

- **Overview:** what this is, who it's for, the goal the owner gave, the stack or form.
- **Layout:** one "where things live" memory per top-level area (`path/ → purpose`, with the
  key files named). On a big repo, write one per important second-level folder too.
- **How to run it,** if it runs: build, test, deploy, the environment it needs (variable names,
  never their values).
- **Glossary:** project terms, names, abbreviations, each with what it means here.

## 3. Units: bottom-up, the loop

```
repeat:
  $L next --project NAME --n 1 --agent <your-id>     -> a unit: id, tier, files, refresh flag
  read it at its tier (deep: every file in full; skim: each file's head; sample: the first lines)
  (a unit with `lines` is a slice of one big file: read only those lines, e.g. offset/limit)
  write 0-8 memories (rules below)
  $L done <id> --project NAME --memories N           (or: skip --note "generated, nothing to learn")
until next returns nothing
```

- **Big files are sliced.** A file larger than a unit (a 17k-line route file, a manuscript in
  one document) is cut at its own section banners or headings into units named `file§section`.
  Tag those memories `unit=<that id>` and `path=<file>`; refresh re-learns only changed slices.
- **Depth.** A deep unit gets 3-8 memories, a skimmed unit 1-3, a sampled unit 0-1 (its shape
  and what produces it). A unit with nothing worth recalling gets `done --memories 0`, which
  is fine. Never write trivia such as "file X exists" or a restatement of the code.
- **Recall before you write.** The same rule often shows up in two units: the code that
  enforces it, and the tests that pin it down. Before writing, recall your concept with
  `learn=<project>`. If a memory from another unit already states the fact, `memory_supersede`
  it with one merged memory that keeps both sets of details, rather than adding a second. In the
  RosterKeep pilot (2026-11-04), duplicates written by separate workers outranked each other in
  4 of 20 self-test misses.
- **Deepen when the plan guessed wrong.** If a skimmed unit turns out to be central (everything
  imports it, or it holds the business rules), run `$L deepen <id>`, read it in full and write
  more.
- **Parallel.** On a big run, start 3-5 sub-agents, each with this skill, the project name and
  a distinct `--agent` id. Each claims its own units from the same ledger. Claims expire after
  2 hours, so a crashed agent's units return to the queue. Write the map (step 2) yourself
  first, so the workers share its vocabulary.
- **Checkpoint.** Every 10 units or so, update the coordinator task with `$L status` and call
  `memory_checkpoint`.

### Writing each memory (this decides whether recall finds it later)

| Field | What to put |
|---|---|
| `concept` | The fact in 3-10 words: "Billing retries failed charges 3 times", not "billing.ts". |
| `content` | **Lead with the rule or fact**, then the specifics. Name 2+ identifiers: file paths, function, class, table or column names, config keys, chapter or character names. Write the **category words** next to them ("Stripe webhook", "Postgres migration", "chapter 12, the heist"), because recall can't find a word that isn't in the body. 2-6 sentences. |
| `questions` | 3-5 ways someone would ask for this later in plain words, without the file names: "How do we retry a failed payment?", "Where does Mara learn the truth?" |
| `project` / `topic` | The project name; the most specific area (`billing-retries`, not `billing`). |
| `intent` / `source` | `context` for how things are, `decision` for a rule someone chose, `finding` for a gotcha; `source: "code-reading"`. |
| `confidence_level` | `observed` for what you read; `assumed` for your interpretation (and say "appears to" in the body). |
| `memory_class` | `canonical` for map memories and for facts you read directly in the files (what a module does, where a thing lives, a chapter's events); `working` (the default) only for your interpretations. |
| `tags` | `learn=<project>`, `unit=<unit id>`, `path=<main file>`, `kind=map|module|flow|howto|glossary|decision|gotcha|character|plot|...`. |

**Check every write's disposition.** AWM's salience gate scores a `working` memory on novelty
and surprise. A plain description of code in a store that already holds related memories often
lands as `staging` or `low-salience`, and those don't come back in ordinary recall. Measured
on 2026-11-04: two of three descriptive writes were staged. If a write you meant to keep comes
back staged, re-write it as `canonical` when it is a fact you read, or drop it when it is only
a guess. On the HTTP fallback, pass `surprise: 0.3` (the MCP default; HTTP defaults to 0).

**Never** write a secret's value: name the variable, not what it holds. AWM redacts known key
shapes, but don't rely on that. If a unit holds personal data (customers, members, patients),
describe its structure only, unless the owner explicitly wants the contents learned.

## 4. Synthesis: what no single unit shows

Once the units are done, or about every 50 on a giant run, recall your own map and unit
memories with `memory_recall` (`learn=<project>`), and write:

- **Flows:** an end-to-end path through the system ("signing up: `routes/signup.ts` →
  `UserService.create` → `email/welcome` → `jobs/trial-expiry`"), or through the story (a plot
  thread across chapters).
- **Architecture and decisions:** the shape, and why it seems built that way. Mark the reasons
  you inferred as `assumed`.
- **How-tos:** add a field, ship a release, add a chapter in the house style.
- **Gotchas:** traps the code or notes warn about, and inconsistencies you found (two
  functions doing the same thing, a character's age that changes).

## 5. Self-test: check that recall finds what you wrote

1. Pick 20 memories across areas: map, units and flows.
2. For each, write a question the way a newcomer would ask it, **in different words** from the
   memory, then `memory_recall` it.
3. A hit means the memory comes back in the top 3. Report the hit rate.
4. For each miss, rewrite the memory with `memory_supersede`: add the missing words to the
   body, add a question, make the concept say the fact. Re-test the misses once.

Over 80% is good. If it is under 60%, the memories are probably too vague or too similar to
each other: split or merge them, then re-test.

## 6. Interview: only what the files can't answer

Collect the open questions from the run: why there are two payment paths, which of two
outlines is current, who owns the reporting module. Ask at most 5-8, one AskUserQuestion round
at a time, starting with the most consequential. Write each answer as a `canonical` memory
with `intent: "decision"` and `source: "discussion"`, and supersede anything it corrects.

## 7. Report and finish

Tell the owner, in plain words:
- coverage (`$L status`) and what was not read, and why;
- how many memories were written, by kind;
- the self-test hit rate;
- 3-5 example questions they can now ask;
- the gaps and open questions;
- how to refresh it later.

Close the coordinator task with the summary, and call `memory_task_end`.

**Optional, only if asked:** write the missing documentation into the folder itself
(an architecture overview, a "where things live" guide, a character bible), built from the
memories. That changes the owner's files, so ask first.

## Continue and refresh

- **Continue** (the ledger exists and units are still pending): run `$L status`, then resume
  at step 3. Re-read the map memories first: `memory_recall` with "<project> overview layout".
- **Refresh** (files changed since the run): run `$L refresh --project NAME`. It reports:
  - `stale`: changed units that were already learned. Re-learn each: recall
    `unit=<id>`, then `memory_supersede` the memories that changed, `memory_retract` the ones
    that no longer hold, and write the new ones. `next` hands out stale units first, and its
    `refresh: true` flag says so.
  - `added`: new units, learned normally.
  - `removed`: units whose files are gone. Retract their memories, unless the fact still holds
    elsewhere.

  Refresh after a big merge or release, or on a schedule (the `schedule` or `loop` skills).
  Map memories change rarely; check them only when top-level folders change.

## Profiles: what each unit's memories capture

| Profile | Per unit | Synthesis |
|---|---|---|
| **Code** | Purpose; entry points and public functions; data shapes (types, tables, columns); configuration and environment variable names; side effects (database, network, files, queues); error handling; tests and how to run them; conventions and gotchas | Request and job flows; the data model; build, deploy and release steps; who calls what |
| **Book or manuscript** | Per chapter or scene: what happens; who appears and what changes for them; places; time; open threads; notable lines and motifs | Character sheets (traits, arc, relationships, facts that must stay consistent); the timeline; plot threads; the style guide (voice, tense, point of view, house rules); continuity risks |
| **Docs or knowledge base** | The rule or procedure; who owns it; when it applies; its exceptions; the source document | Cross-references; contradictions between documents; what is out of date |
| **Data folder** | Shape (columns and types), source, how it is produced, how often it refreshes, size, the key fields | Lineage: what feeds what |
| **Design or assets** | What exists, and where; naming; versions | The brand rules |

## Scale rules

- **Budget first.** The plan prices the run before anything is read. Above about 300k tokens,
  confirm with the owner. The first pass on a huge repo can be skim-only, then `deepen` the
  units recall shows people actually ask about.
- **Don't flood the store.** Write at most 8 memories per unit. A 1,000-unit repo should come
  to roughly 2-4k memories, not 20k: recall gets noisier as near-duplicates pile up.
- **The ledger is the truth for coverage.** Never claim an area is learned unless its units
  are `done`.
