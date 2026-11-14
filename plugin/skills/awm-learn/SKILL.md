---
name: awm-learn
description: >-
  Learn a whole repo or folder into AWM memory — code, a manuscript, a docs tree of
  requirements, minutes and policies, a data folder, anything — systematically and resumably,
  so every agent on the team can recall how it works and where everything is. Surveys the
  corpus first (what each file is, how authoritative, its dates, where the decisions are
  written), plans the work into units with a ledger, reads each kind of file with its own
  playbook within a token budget, reconciles with what memory already holds, resolves
  conflicting sources by authority and date, tests its own recall, asks the owner only what
  the files can't answer, and refreshes when files change. Use when someone
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
$L survey <path>                   $L plan <path> --project NAME [--order chronological]
$L next --project NAME --n 1 --agent <you>      $L done <unit> --project NAME --memories N --tokens T
$L skip <unit> --project NAME --note "why"      $L deepen <unit> --project NAME
$L status --project NAME           $L refresh --project NAME      $L list
```

## 0. Survey: what is this, before anything is read

First run `$L list`. If a ledger already exists for this path, this is a **continue** or
**refresh** run: go to the section "Continue and refresh".

Otherwise run `$L survey <path>`. It reads nothing for meaning; from names, folders, the first
few KB and the git history it reports, in about a second:

- **the profile:** code, docs, manuscript, data or mixed;
- **the role of every file:** source, test, migration, script, config, decision record,
  requirement, minutes, policy, plan, changelog, reference, guide, chapter. PDFs and Word
  files count too, as documents you read with a document tool;
- **authority:** how far a file's statements should be trusted against another's. Decision
  records and requirements rank highest, then policy, code, references and changelogs; minutes
  and plans rank lower; drafts, archived and superseded material ranks last;
- **dates:** each file's first and last commit, and any date written in its name or text,
  which gives the timeline;
- **decision markers:** the line numbers where the why lives. In code these are comments that
  give a reason, flag a trap or cite a ticket. In documents they are "Decision:", "Action:",
  "Status:" and "Superseded by" lines;
- **what it held back:** secrets, binaries, and anything that looks personal or confidential
  (a `medical/` or `backups/` folder, a payroll export). These stay out unless the owner says
  otherwise (`--allow-sensitive`).

The survey is a guess from patterns. Its job is to make the owner's questions short.

## 1. Intake (one round, four questions at most)

Ask only what the survey can't tell you, with AskUserQuestion:

1. **Is the survey right, and what should memory get good at?** Show its one-line verdict:
   "This looks like a code repo with 68 migrations and 263 test files, and no decision
   records". Then ask what memory should get good at. For example: "answer how-does-X-work
   questions about the API", "know which requirement is current", "keep the characters and
   timeline of my novel straight". If the owner knows which documents are authoritative ("the
   board minutes overrule the old policy"), that answer outranks the survey's scores.
2. **The project name** for the `project` field. Suggest one short word.
3. **Anything off limits?** Name what the survey held back as possibly sensitive, and ask
   about client folders, drafts and generated output. Exclusions go into `--exclude` or a
   `.awmlearnignore` file in the folder.
4. **The budget.** Show the plan's cost (step 2) and offer: the planned depth (recommended),
   skim everything (cheapest), or deeper.

Pick the **profile** and the reading playbooks from the survey (section "Reading playbooks").

## 2. Plan

```
$L plan <path> --project NAME [--exclude "glob,glob"] [--budget TOKENS] [--order importance|chronological]
```

The plan:
- lists every file, using `git ls-files` when the folder is a repo;
- skips dependencies, build output, lockfiles, binaries and **secrets** (`.env`, keys,
  credentials);
- groups the files into **units**: a folder's files, split at about 48 KB, and any large file
  on its own;
- ranks the units: entry points and the top of the tree first, then what records decisions
  (decision records, requirements, policy, files dense with why-comments), then the
  most-changed files, then size; superseded, archived and draft material goes last;
- assigns each unit a depth: `deep` (read in full), `skim` (the first ~3 KB of each file) or
  `sample` (data: the first lines only, for the shape).

The default budget is enough to skim everything, plus 300k tokens to read the most important
units in full. The estimate now includes each unit's overhead (the agent's running context,
recalls and tool round-trips), calibrated on the first full run, which used 2.5 times the old
estimate. Treat it as a guide, not a quote.

**Order.** `importance` (the default) learns the most important units first. Use
`--order chronological` when the survey suggests it: dated minutes, decision records or a
manuscript. The map comes first, then the oldest dated material, so a later decision
supersedes an earlier one when the run reaches it, the way it happened.

Show the owner the summary lines: files, units, depth split, estimated tokens, what is not read.
**If the estimate is over about 300k tokens, confirm before going on.** Offer to narrow the
scope with `--exclude` or a sub-folder, or to lower `--budget`.

Then create one coordinator task so other sessions can find the run:
`memory_task_add(concept: "awm learn <project>", content: path, ledger, goal, profile, budget)`.

## 3. Map: top-down, before any unit

Read the root files, the manifests and the folder tree (`$L status --json` lists the units).
Write these **map memories** first. They make recall useful immediately, even before a single
unit is learned:

- **Overview:** what this is, who it's for, the goal the owner gave, the stack or form.
- **Layout:** one "where things live" memory per top-level area (`path/ → purpose`, with the
  key files named). On a big repo, write one per important second-level folder too.
- **How to run it,** if it runs: build, test, deploy, the environment it needs (variable names,
  never their values).
- **Glossary:** project terms, names, abbreviations, each with what it means here. **Map the
  user's words to the code's words.** People ask in the words on the screen ("Paperwork",
  "Activity history", "unsubscribe"), while the code says `clearance_record`, `audit_log` and
  `email_suppression`. Write both in the same memory. In the first full run, all three real
  self-test misses were questions asked in screen words about memories written in code words.
  If the user-facing labels live elsewhere (a web app next to the API), skim them for this.
- **Sources of truth:** which documents are authoritative for what, from the survey and the
  owner's answer ("current requirements: `specs/`; the 2025 spec is superseded").

## 4. Units: bottom-up, the loop

```
repeat:
  $L next --project NAME --n 1 --agent <your-id>     -> a unit: id, role, authority, date, tier,
                                                        files, markers, recentCommits, refresh flag
  read it with its role's playbook (below), at its tier
  (a unit with `lines` is a slice of one big file: read only those lines, e.g. offset/limit)
  reconcile with what memory already holds, then write 0-8 memories (rules below)
  $L done <id> --project NAME --memories N --tokens T   (or: skip --note "generated, nothing to learn")
until next returns nothing
```

`--tokens` is your best count of what the unit cost. `status` then reports the measured cost
against the estimate, so the next run's price is calibrated.

- **Read the markers first.** `markers` lists `file:line,line,...` where a comment or a
  document line states a reason, a trap, a ticket or a decision. Read those lines, and the
  code around them, before anything else: they are where decisions live.
  `recentCommits` gives the last few commit subjects for the unit's files, which often say
  why something changed ("fix: a less-trusted write never merges into a more-trusted one").

- **Big files are sliced.** A file larger than a unit (a 17k-line route file, a manuscript in
  one document) is cut at its own section banners or headings into units named `file§section`.
  Tag those memories `unit=<that id>` and `path=<file>`; refresh re-learns only changed slices.
- **Depth.** A deep unit gets 3-8 memories, a skimmed unit 1-3, a sampled unit 0-1 (its shape
  and what produces it). `done --memories 0` is only for a unit with nothing a person would ask
  about (generated code, fixtures, a test whose rules this run already wrote into its module's
  memory). Never write trivia such as "file X exists" or a restatement of the code.
- **This run's memories are the coverage; older notes are not.** Every fact a newcomer would
  ask about needs a memory written by this run (tagged `learn=<project>`), stated whole, in
  the module's terms, even when an older note mentions it. Older notes in the store (session
  logs, checkpoints, task reports, decisions taken months ago) are written for a different
  reader: they mix several things, lead with history, and make poor answers. Measured on
  2026-11-04: a run that counted them as coverage wrote 158 memories where the first run wrote
  347, closed 14 units with none, and answered 14 of 30 fresh questions where the first run
  answered 24.
- **Reconcile before you write.** Recall your concept across the whole project, not only
  `learn=<project>`. Then, for each fact:
  - **A memory from this run already states the same fact** (the code and its tests saying
    one rule twice): supersede it with one memory that keeps both sets of details. Don't add
    a second. Change the concept's wording a little, or the write merges into the old memory
    instead.
  - **A memory from this run covers the same area but a different fact** (another rule about
    payments, another step of sign-up): write a new memory. Never grow one memory per area.
    Measured on 2026-11-04: merging every related fact into one memory per area made bodies
    half as long again (median 1,181 characters against 791, 55 over 1,500 against none), and
    the specific fact a question asked for was buried mid-body and lost to one-fact memories.
  - **An older note states it, and it still holds:** write this run's memory anyway, whole.
    Leave the older note alone; it is history, and recall ranks the clearer memory first.
  - **An older note states something the file now contradicts:** write this run's memory,
    then supersede the older note with it (or `memory_write` with `correction: true`). If the
    older note records a later decision than the file shows (someone decided to change it),
    keep both, and write a gotcha: "the code still does X; decided on <date> to do Y".
  - **New:** write it.
- **Deepen when the plan guessed wrong.** If a skimmed unit turns out to be central (everything
  imports it, or it holds the business rules), run `$L deepen <id>`, read it in full and write
  more.
- **Parallel.** On a big run, start 3-5 sub-agents, each with this skill, the project name and
  a distinct `--agent` id. Each claims its own units from the same ledger. Claims expire after
  2 hours, so a crashed agent's units return to the queue. Write the map (step 3) yourself
  first, so the workers share its vocabulary. **Give each worker its own areas** (folders or
  topics) where you can, because two workers in one area write the same fact twice. And keep
  each worker's session short (10-15 units), because a long session re-reads its growing
  context on every call, which is where most of the first run's extra cost went.
- **Checkpoint.** Every 10 units or so, update the coordinator task with `$L status` and call
  `memory_checkpoint`.

### Writing each memory (this decides whether recall finds it later)

| Field | What to put |
|---|---|
| `concept` | **The product's name, then the fact** in 3-10 words: "Acme billing retries failed charges 3 times", not "billing.ts". People ask with the product's name ("in Acme, how do…"), and a store holds other projects whose memories carry that name too: in the 2026-11-04 re-run, 142 of 158 memories left it out and were outranked by older notes that had it, so 5 of 20 questions were answered instead of 17. |
| `content` | **Lead with the rule or fact**, then the specifics. Name 2+ identifiers: file paths, function, class, table or column names, config keys, chapter or character names. Write the **category words** next to them ("Stripe webhook", "Postgres migration", "chapter 12, the heist"), because recall can't find a word that isn't in the body. **One fact per memory**, 2-6 sentences, about 500-1,000 characters; the concept names that one fact, not a list of topics ("Acme deposited payments cannot be edited or deleted", not "Acme payments: deposits, refunds, editing and exports"). |
| `questions` | 3-5 ways someone would ask for this later in plain words, without the file names: "How do we retry a failed payment?", "Where does Mara learn the truth?" |
| `project` / `topic` | The project name; the most specific area (`billing-retries`, not `billing`). |
| `intent` / `source` | `context` for how things are, `decision` for a rule someone chose, `finding` for a gotcha; `source: "code-reading"`. |
| `confidence_level` | `observed` for what you read; `assumed` for your interpretation (and say "appears to" in the body). |
| `memory_class` | `canonical` for map memories and for facts you read directly in the files (what a module does, where a thing lives, a chapter's events); `working` (the default) only for your interpretations. |
| `tags` | `learn=<project>`, `unit=<unit id>`, `path=<main file>`, `kind=map|module|flow|howto|glossary|decision|gotcha|requirement|action|character|plot|...`, `role=<the unit's role>`, `authority=<0-100>`, and `date=<the document's own date>` when it has one. |
| `valid_from` / `valid_to` | For dated material, the date it took effect (a meeting's date, a policy's effective date). For something superseded or archived, `valid_to` the date it stopped being true, so recall shows it as history. |

**Check every write's disposition.** AWM's salience gate scores a `working` memory on novelty
and surprise. A plain description of code in a store that already holds related memories often
lands as `staging` or `low-salience`, and those don't come back in ordinary recall. Measured
on 2026-11-04: two of three descriptive writes were staged. If a write you meant to keep comes
back staged, re-write it as `canonical` when it is a fact you read, or drop it when it is only
a guess. On the HTTP fallback, pass `surprise: 0.3` (the MCP default; HTTP defaults to 0).

**Never** write a secret's value: name the variable, not what it holds. AWM redacts known key
shapes, but don't rely on that. If a unit holds personal data (customers, members, patients),
describe its structure only, unless the owner explicitly wants the contents learned.

## Reading playbooks: what to take from each role

The survey's role decides what you look for. Read with the playbook, then write the memories
the playbook names.

| Role | Look for | Write |
|---|---|---|
| **Source code** | The marked comment lines first; public functions and routes; data shapes; config and env var names; side effects; error handling | What the module does and the rules it enforces, with the reason when a comment or commit gives one (`intent: decision` for a deliberate choice) |
| **Tests** | What behaviour they pin down, and the edge cases | **Fold it into the module's memory** ("pinned by `foo.test.ts`: ..."). Don't write a separate test memory. In the first run, 128 of 344 memories were test memories that restated the code's rules and competed with them |
| **Migrations / schema** | Tables, columns, constraints, what each migration changed and when | The data model, and the order things changed |
| **Decision record** | The decision, its context, the options rejected, the consequences, its status, what it supersedes | One `decision` memory per decision, with `valid_from` its date. If it supersedes another, supersede that memory too |
| **Requirement / spec** | Each requirement with its id, the "shall/must" statements, acceptance criteria, scope | One memory per requirement or per small group, keeping the ids. If the code disagrees, write a gotcha and add it to the interview |
| **Minutes / meeting notes** | Decisions made, action items with owners and due dates, who was there, open questions | One memory per decision and one per open action, with `valid_from` the meeting date. Skip the discussion itself |
| **Policy / procedure** | The rule, who it applies to, when, its exceptions, the owner, the effective date | The rule as a canonical memory |
| **Plan / proposal** | The intent, and whether it was adopted | Mark it as a plan, not a fact ("proposed on <date>"). A later decision or the code outranks it |
| **Changelog / release notes** | What changed and when | The timeline of the change, linked to the module it changed |
| **Reference / glossary** | Terms and facts | Glossary memories |
| **Chapter / manuscript** | What happens, who appears and changes, places, time, open threads | In order, keeping characters and the timeline consistent |
| **Superseded / archived / draft** | Only what still explains the present | History with `valid_to`, or nothing. Never write it as a current fact |

**When two sources disagree,** rank them in this order:
1. the owner's word;
2. higher authority;
3. at equal authority, the newer date.

Code is the truth about what the system does today. Decision records and requirements are the
truth about what was meant. When the two disagree, that is not a tie to break. It is a finding:
write it as a gotcha and ask about it in the interview.

## 5. Synthesis: what no single unit shows

Once the units are done, or about every 50 on a giant run, recall your own map and unit
memories with `memory_recall` (`learn=<project>`), and write:

- **Flows:** an end-to-end path through the system ("signing up: `routes/signup.ts` →
  `UserService.create` → `email/welcome` → `jobs/trial-expiry`"), or through the story (a plot
  thread across chapters).
- **Architecture and decisions:** the shape, and why it seems built that way. Mark the reasons
  you inferred as `assumed`.
- **How-tos:** add a field, ship a release, add a chapter in the house style.
- **Gotchas:** traps the code or notes warn about, and inconsistencies you found (two
  functions doing the same thing, a character's age that changes, a spec the code no longer
  follows).
- **Timeline:** for dated material, how a decision changed over time ("the fee rule: proposed
  2025-03, adopted 2025-05, changed 2026-01"), superseding the earlier versions.
- **A duplicate sweep.** For each main topic, recall `learn=<project>` plus the topic and merge
  near-duplicates that separate units or workers wrote (`memory_supersede` into one).

## 6. Self-test: check that recall answers the question

1. Pick 20 memories across areas: map, units and flows.
2. For each, write a question the way a newcomer would ask it, **in different words** from the
   memory, then `memory_recall` it.
3. Score two numbers:
   - **answered:** a memory in the top 3 answers the question correctly, whichever memory it
     is. This is the number that matters to the person asking;
   - **target found:** the memory you picked is in the top 3.
   In the first full run the "target" number was 12-14 of 20, while 17 of 20 questions were
   in fact answered; most "misses" were another memory, often an older one, giving the same
   correct answer. Report both.
4. For each question not answered, name the cause:
   - **vocabulary:** asked in other words → add those words and a question;
   - **duplicate:** two near-copies outrank each other → merge;
   - **outranked:** an older or wrong memory wins → supersede or correct it;
   - **missing:** never written → write it.
   Fix, then re-test the misses once.

An answered rate over 80% is good. If it is under 60%, the memories are probably too vague or
too similar to each other: split or merge them, then re-test.

## 7. Interview: only what the files can't answer

Collect the open questions from the run: why there are two payment paths, which of two
outlines is current, who owns the reporting module, and every place a spec and the code
disagree. Ask at most 5-8, one AskUserQuestion round
at a time, starting with the most consequential. Write each answer as a `canonical` memory
with `intent: "decision"` and `source: "discussion"`, and supersede anything it corrects.

## 8. Report and finish

Tell the owner, in plain words:
- what the survey found (profile, roles, sources of truth) and what was held back;
- coverage (`$L status`) and what was not read, and why;
- the measured cost against the estimate;
- how many memories were written, by kind;
- the self-test: answered and target-found rates;
- 3-5 example questions they can now ask;
- the gaps and open questions;
- how to refresh it later.

Close the coordinator task with the summary, and call `memory_task_end`.

**Optional, only if asked:** write the missing documentation into the folder itself
(an architecture overview, a "where things live" guide, a character bible), built from the
memories. That changes the owner's files, so ask first.

## Continue and refresh

- **Continue** (the ledger exists and units are still pending): run `$L status`, then resume
  at step 4. Re-read the map memories first: `memory_recall` with "<project> overview layout".
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

## Profiles: the shape of the whole run

The survey's profile sets the shape of the run; the reading playbooks above cover each unit.

| Profile | Per unit | Synthesis |
|---|---|---|
| **Code** | Purpose; entry points and public functions; data shapes (types, tables, columns); configuration and environment variable names; side effects (database, network, files, queues); error handling; the reasons in comments and commits; conventions and gotchas. Tests fold into their module | Request and job flows; the data model; build, deploy and release steps; who calls what; where the code and the specs disagree |
| **Book or manuscript** | Per chapter or scene: what happens; who appears and what changes for them; places; time; open threads; notable lines and motifs | Character sheets (traits, arc, relationships, facts that must stay consistent); the timeline; plot threads; the style guide (voice, tense, point of view, house rules); continuity risks |
| **Docs or knowledge base** | By role: requirements, decisions, minutes, policy, plans, references (see the playbooks). Each with its source document, date and authority | The sources of truth; the timeline of each decision; contradictions between documents, resolved by authority and date; what is out of date |
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
