# Writing memories so recall can find them

*For anyone putting an agent on AWM — Claude, GPT, Gemini, a local model, a script. The rules
are about the store, not the harness. Ten minutes. The last section is a block you can paste
into any agent's instructions.*

---

## Why this page is the lever

The retrieval figures AWM publishes — **98.7% of identifier and of topic queries have the right
memory in the top five; 95.0% of identifier queries and 96.2% of topic queries put it first**
(v0.22.4) — were measured on a real store whose memories were written the way this page says to. AWM is good at finding what is
findable. It cannot rescue a memory that never contains the words a future question will use.

Measured on an 11,000-memory store: 94% of tagged memories were missing at least one of their
own topical terms from the body, and 66% of those terms never appeared in the text at all. Those
memories exist, carry the right tag, and are unreachable by the question that needs them. The
write is where recall quality is decided.

## What the pipeline sees

A recall runs three channels over a candidate pool and a cross-encoder reranks the survivors.
Each channel reads a different part of the memory, which is why the rules below are shaped the
way they are.

| Stage | What it reads | What that means for the write |
|---|---|---|
| BM25 (lexical) | `concept`, `content`, and tags | Exact words matter. A synonym in your head is not a match. |
| Embedding (semantic) | `concept + content` only | Tags are invisible here. A word that lives only in a tag has no semantic weight. |
| Entity index (opt-in, `AWM_ENTITY_INDEX_FETCH=1`) | structured identifier tags (`ticket=`, `person=`, …) | Exact lookup by id. Keep identifiers spelled consistently. |
| Cross-encoder rerank | a 400-character window of the body, densest in query terms, plus `topic=`/`proj=`/`project=` tags capped at 80 characters | The decisive identifier should appear early. Measured: 86.7% → 44.9% first place when the identifier sits beyond the 400-character window, on the public corpus (v0.22.4). |

## The rules

**1. Lead with the fact or the rule.** The first one or two sentences carry the most weight in
every channel. Open with the thing itself, not the backstory.

> ✗ "While investigating the settlement flow after the audit, it turned out that…"
> ✓ "Period-close BLOCKED is enforced server-side in `SettlementService.closeRun()`, not only in the page."

**2. Include two or more retrievable identifiers.** File paths, function names, column names,
ticket ids, exact error strings — the literal terms a future query will use.
`tblMemberDetails.activation_date` beats "the activation column". `schema/072-settlement-lock.sql`
beats "the migration".

**3. Name the category next to the specifics.** Specifics make a memory precise; category words
make it reachable. A memory that says "private plan memory peaked 88%, scale P1v3 → P2v3" never
says *Azure* or *App Service Plan*, so a question asked in those words cannot find it. On the
real store that memory was not in the top 40 candidates for "azure app service plan capacity
increase". Write the system, product and domain nouns beside the identifiers.

**4. Write in the vocabulary of the future question.** Imagine asking about this in three
months. Use those nouns. Do not paraphrase the user's domain language into a neutral summary.

**5. Tag it and write it.** Tags boost lexical scoring and feed the entity index, but the
embedding never sees them and the reranker sees only `topic=`/`proj=`/`project=`. A tag is not a
substitute for the word in the body.

**6. Pick the most specific topic tag.** `auth-magic-link-rate-limit`, not `auth`. Topic is a
ranking signal at recall time, not a filter: keyword search indexes it, and the rerank passage
carries `topic=`/`proj=`/`project=` tags within 80 characters (`memory_recall` has no topic
parameter). A generic topic adds noise where a specific one adds signal, and the memory competes
with everything in the area. This is about the tag — rule 3 still wants the category in the body.

**7. Say why, for any rule.** "Don't mock the database" is brittle. "Don't mock the database —
mocked tests masked a broken migration last quarter" can be applied to a case nobody
anticipated.

**8. Reserve `canonical` for stable invariants.** Decisions, requirements, hard facts, context
other agents must be able to recall. Findings, observations and progress notes are `working`.
The canonical floor is 0.7 salience; overusing it makes the floor meaningless.

**9. One fact per memory.** A memory that bundles three decisions matches three questions
weakly instead of one strongly, and cannot be superseded cleanly when one of them changes.

**10. Correct, don't accumulate.** When a fact changes, supersede the old memory or write the
new one with `correction: true`. Written as a plain observation, a changed value merges into or
ranks below the stale version. Measured: "departs 8:40" lost to "departs 10:15" that way.

## The structured fields

Every write should carry these. The schema accepts them all as optional; a write without them
succeeds and simply retrieves worse.

| Field | Format | Example |
|---|---|---|
| `project` | one short word for the project | `"EquiHub"` |
| `topic` | one or more lowercase area words, specific | `"period-close"` |
| `intent` | `decision` · `finding` · `todo` · `question` · `context` | `"finding"` |
| `confidence_level` | `verified` (tested) · `observed` (read in code) · `assumed` | `"verified"` |
| `source` | `code-reading` · `debugging` · `discussion` · `research` · `testing` · `observation` | `"debugging"` |
| `memory_class` | `canonical` · `working` (default) · `ephemeral` | `"canonical"` |
| `tags` | identifier prefix-tags: `ticket=`, `person=`, `date=YYYY-MM-DD`, `version=`, domain ids | `["ticket=10001", "date=2026-05-11"]` |
| `questions` | 2–5 natural questions the memory answers (up to 5), worded the way someone would ask later without your file names or ids. Keyword-indexed only; natural-language first place 48.5% → 53.1% on the real store | `["How do I ship the club app to production?"]` |
| `slot` | entity + attribute for a value that changes; a later write to the same slot (same agent, same class) supersedes this one automatically | `"rosterkeep.deploy-command"` |
| `aliases` | other names for the person, organisation or thing the memory is about, so `memory_about` finds it by any of them | `["Jenna", "Jenna Park"]` |

Set `valid_to` on operational facts with a shelf life (a deploy state, "waiting on a reply"),
and `valid_from` on facts that become true on a known date. Leave both unset for durable facts.

## One memory, before and after

**Before** — exists, is tagged, cannot be found by the question that needs it:

```
concept:  found a bug
content:  The thing I was looking at was broken so I fixed it.
```

**After** — leads with the fact, names the category and the identifiers, says why:

```
concept:  EquiHub period-close BLOCKED check missing server-side
content:  apps/web/app/(billing)/billing/settlement-lock/page.tsx had client-only
          BLOCKED enforcement. Fixed by adding a server-side check in
          SettlementService.closeRun() per schema/072-settlement-lock.sql. Without
          the server-side check a direct API call could bypass the period-close lock.
project:  EquiHub        topic: period-close        intent: finding
confidence_level: verified    source: debugging     memory_class: canonical
tags:     ticket=10001, person=Robert, date=2026-05-11, topic=security
```

Future questions that now reach it: "period close lock", "settlement lock bypass",
"ticket 10001", "closeRun server side", "billing security finding May".

## A block to paste into any agent's instructions

This is harness-neutral. It assumes the agent has a write tool that accepts the fields above,
whether that is the MCP `memory_write` tool, `POST /memory/write`, or a wrapper.

```
When you write a memory:
- Lead with the fact or rule in the first sentence. Backstory comes after.
- Include at least two exact identifiers: file paths, function names, column names,
  ticket ids, error strings.
- Name the system or domain the fact belongs to (the product, service, table, or
  concept) in the body, next to the identifiers. A tag alone is not enough.
- Use the words a future question will use. Do not paraphrase domain terms.
- Give a reason for any rule.
- One fact per memory. If a fact changes, supersede the old memory or write the
  new one as a correction; do not add a second version beside the first.
- Set project, topic (specific), intent, confidence_level and source on every write.
  Add ticket=, person=, date= and version= tags when the content has them.
- Add 2-5 questions the memory answers, phrased the way someone would ask later
  without remembering your wording, file names or ids.
- Give a slot (entity.attribute, e.g. rosterkeep.deploy-command) to any value
  that can change; writing the same slot again replaces the old value.
- When the memory is about a person, organisation or thing, tag it (person=,
  org=, contact=) and pass its other names as aliases.
- Use memory_class canonical only for decisions, requirements and verified facts
  other agents must be able to recall.
```

## How to check your own store

`memory_recall` with `granularity: 'compact'` shows the query-aware snippet that scored each
result. If the memory you expected is missing, ask the question three ways with different nouns.
If none reach it, read the memory: usually the body never says the word you searched for.
Supersede it with a version that does.

The same measurement that produced the headline figures can be run against your own store with
`npm run bench` once a snapshot exists; see [`benchmarks.md`](benchmarks.md).
