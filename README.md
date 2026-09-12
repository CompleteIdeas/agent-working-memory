# AgentWorkingMemory (AWM)

**Give your AI coding agent a memory that survives the conversation — and knows when to stay quiet.**

Every session with an AI assistant starts blank. It has forgotten what your team decided last
week, which approach was tried and rejected, and which table actually holds the thing it needs.
So it re-derives all of it — reading files, running searches, asking you — and on a large project
it will confidently rebuild something that was already decided against.

AWM fixes that with one local process and one SQLite file. The agent writes short notes as it
learns; AWM decides which are worth keeping, hands back the two or three that matter when asked,
and says **nothing** when nothing fits.

```bash
npm install -g agent-working-memory && awm setup --global
```

Restart Claude Code. 19 tools appear. No cloud, no API keys, nothing leaves your machine.

<p align="center">
  <a href="https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/for-decision-makers.md"><b>Deciding whether to adopt it? →</b></a> &nbsp;·&nbsp;
  <a href="https://github.com/CompleteIdeas/agent-working-memory/blob/master/docs/walkthrough.md"><b>Want the mechanism walked through? →</b></a> &nbsp;·&nbsp;
  <a href="https://completeideas.github.io/agent-working-memory/"><b>Docs site →</b></a>
</p>

---

## What it does, measured

Every number below is reproducible from this repository against a frozen copy of a **real
30,000-memory store** — not synthetic test data. Method and corrections: [`docs/benchmarks.md`](docs/benchmarks.md).

| | |
|---|---|
| **Returns the right memory first** | **92.7%** of identifier queries · **92.0%** of topic queries · ~97% in the top five |
| **Stays silent when it should** | **90%** correct abstention on questions about facts never stored |
| **Halves the digging** | Same agent, same tools, four real support tickets: with memory, **2× the specific facts** the real answer needed and **half the database queries** (49 vs 100). On one ticket the memoryless arm ran 25 queries, exhausted its budget and answered nothing; the memory arm answered in 4. |
| **Holds decisions for months** | On a six-month application project, recorded decisions were recalled a median of **30 days** after being written — some after **167 days**. 41% of the technical identifiers the agent used had entered the conversation *only* through a recall. |
| **Costs a fraction to answer** | Scoped recall answers in **~630 tokens flat** regardless of store size. Carrying the memory store instead: ~1.3M tokens. Reading the codebase: doesn't fit in any window. |
| **Lets a cheap model punch up** | A small model plus AWM out-performed a frontier model on a 15-task domain workload at **~1/40th the cost** — **14/15 vs 7/15**, $0.007 vs $0.277 per task. |

Two independently built fixtures agree within a point. Warm recall takes about half a second.

<details>
<summary><b>How these numbers were corrected upward in September 2026</b> — read before comparing to older figures</summary>

Earlier published figures (s@1 63.8% category, 70.0% identifier) were **understated by the
measuring instrument, not the engine**. Two defects, both found and fixed in 0.14.4–0.14.5: the
benchmark's decay clock ran on the wall clock, so the "frozen" snapshot aged a day per day; and the
runner queried every gold as the `work` agent while a quarter to a third belonged to `personal`,
so agent isolation cut them before scoring. Nothing in retrieval changed between 63.8 and 92.0.
The within-day *deltas* published earlier (e.g. the +7.4pp tags win) stand. Full account in
[`docs/benchmarks.md`](docs/benchmarks.md) → correction notes.
</details>

---

## Why it works when a vector store doesn't

Most "memory for AI" stores everything and retrieves by similarity. AWM makes the opposite bet:
**a memory is only useful if it is selective.**

**It refuses most of what it sees.** Every write is scored for importance before storage —
is it new, is it a decision or a root cause, does it name its subject? About a third of what
the agent offers is kept at full confidence. The rest never competes, so recall stays sharp as
the store grows.

**It forgets gracefully.** Memories that keep getting used stay strong; ones nobody touches
fade from ranking without being deleted. The model is borrowed from cognitive science (ACT-R),
and it means no one curates the store.

**It tells you when it doesn't know.** When the top candidates are only marginally better than
the tenth, AWM returns nothing and says how many it withheld. A confident wrong memory is more
expensive than an admitted gap — the benchmark scores the silence as a win.

**It knows what changed.** When a fact is corrected, the old memory is marked superseded and
carries a visible warning if it ever surfaces. A notes file has two paragraphs that read with
equal confidence; AWM knows which one won. One project has 108 such supersessions — an agent
resuming it gets one current state, not five.

**It stays local and per-person.** One SQLite file, three small ONNX models (~200 MB, once).
Work and personal memories are separate pools; several sessions share a pool safely.

<details>
<summary>Against a typical RAG / vector store, feature by feature</summary>

| | Typical vector store | AWM |
|---|---|---|
| Storage | Everything | Salience-filtered: active / staging / low-confidence fallback |
| Retrieval | Cosine similarity | Keyword + vector candidates → liveness scoring → cross-encoder rerank → abstention gate |
| Forgetting | Manual cleanup | ACT-R decay; reinforced knowledge persists |
| Correction | Delete and re-insert | Supersede with a visible pointer; retract with confidence propagation to neighbours |
| Duplicates | Stored again | Reinforce the existing memory instead |
| Wrong answers | Best of a bad set | Returns nothing, says why |
| Named things | Vocabulary-dependent | Entity index on tickets, people, tables, files |
| Feedback | None | Useful / not-useful adjusts confidence and rank |
| Multi-agent | Per-instance | Shared store, per-agent scoping, opt-in shared workspace |
</details>

---

## Who uses it

- **Long-running coding agents** that need cross-session project knowledge
- **Support and operations agents** that must remember what was already decided on a ticket
- **Multi-agent pipelines** where specialised agents share one memory
- **Local-first teams** for whom cloud memory is not acceptable
- **Any MCP host** — Claude Code, [Hermes Agent](docs/integrations/hermes.md), or your own agent over a local HTTP API

**Not** a chatbot, a hosted service, a generic vector database, or a replacement for your
code and tickets as the source of truth. Recall first; verify against the source when it
matters; supersede when reality differs.

---

## Get started

```bash
npm install -g agent-working-memory
awm setup --global          # MCP config, CLAUDE.md guidance, hooks
```

Requires **Node.js 22+**. Restart Claude Code; the first conversation is ~30 s slower while the
models download. Upgrading is the same two commands — the database is preserved and every
release to date has been backward compatible.

Starting on an existing project? Warm-start the store from its own docs so recall is useful
on day one:

```bash
awm onboard ./docs --repo . --project <name>    # review the pack, then
awm import <pack> --db <path> --dedupe
```

| Next | |
|---|---|
| Install, first write, first recall | [`docs/quickstart.md`](docs/quickstart.md) |
| Separate pools per project, incognito mode, hooks | [`docs/claude-code-setup.md`](docs/claude-code-setup.md) |
| Teams and multi-agent | [`docs/team-setup-guide.md`](docs/team-setup-guide.md) |
| Custom agents over HTTP | [`docs/reference.md`](docs/reference.md) |

---

## Recommended configuration

Three retrieval improvements ship default-off and should be enabled **together**:

```bash
AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1
```

Second-stage rerank by the cross-encoder's own score; a 400-character rerank window placed on
the densest query-term region rather than the prefix (**25% → 87.5%** on long memories); and
tags fed into the rerank passage (**+7.4pp**). `memory_whoami` prints the active fingerprint so
you can confirm a running process actually has them. Every other variable, with its measured
effect and the experiments that were rejected: [`docs/reference.md`](docs/reference.md).

---

## How it works, in one paragraph

A write is scored for salience — novelty against the existing store, event type, whether it
names identifiers — and lands active, staged, or low-confidence. A recall casts a wide net with
keyword and vector search, scores each candidate for relevance and liveness, lets linked
memories vote, hands the shortlist to a cross-encoder that actually reads the text, then checks
whether the score distribution justifies answering at all. A maintenance pass on session end
clusters, decays unused links, and archives what has gone cold. Corrections supersede rather
than overwrite.

The whole thing, one memory followed end to end with every threshold sourced:
[`docs/walkthrough.md`](docs/walkthrough.md). The mental model an engineer needs to predict its
behaviour — proposers, deciders, and when it stays silent: [`How AWM decides what to say`](https://completeideas.github.io/agent-working-memory/pipeline-walkthrough.html).
The theory and its citations: [`docs/cognitive-model.md`](docs/cognitive-model.md).

---

## Honest limits

- No help on small one-off tasks — the overhead pays back when knowledge is reused or the
  project outgrows the context window.
- Recall is bounded by what was written. A memory that never names its subject can't be found
  by it. The writing guidance exists for this reason.
- The association graph, as of this release, rarely changes a final answer; the reranker does.
- It is 0.x, and it says so: the benchmark was corrected three times this month when the
  instrument turned out to be wrong. The corrections are documented in place, not revised away.

Everything else, with evidence and workarounds: [`docs/known-limitations.md`](docs/known-limitations.md).

---

## What's new — v0.14.6

Nothing in the retrieval engine changed in the last four point releases; what changed is how it
is measured, invoked, and reports on itself.

- **Benchmark instrument corrected twice; real numbers are higher.** Identifier s@1 92.7%,
  category 92.0%, abstention unchanged at 90%. The runner now pins its clock and queries as each
  gold's own agent.
- **Feedback joins to its recall.** `memory_recall` ends with `[recall_id: …]`;
  `memory_feedback` accepts it. Before this every feedback row in the live store was orphaned.
  `memory_stats` now reports outcome numbers instead of activity counters.
- **One hook sidecar per session.** Each session's process binds the first free port from 8401
  upward; `memory_whoami` reports the port it actually holds.
- **An empty recall no longer claims absence.** `RECALL ABSTAINED` with the withheld count,
  instead of "No relevant memories found."

Full history back to v0.6.0: [CHANGELOG.md](CHANGELOG.md).

---

## Reference

The README points outward; it does not duplicate. Everything below is the authoritative source.

| | |
|---|---|
| **All 19 MCP tools**, every HTTP endpoint with schemas, every environment variable with its measured effect | [`docs/reference.md`](docs/reference.md) |
| Architecture, pipelines, schema, backends (SQLite · PGlite · Postgres) | [`docs/architecture.md`](docs/architecture.md) · [`docs/pglite-feature-parity.md`](docs/pglite-feature-parity.md) |
| Every eval suite — what it measures, how to run it, and how each number was corrected | [`docs/benchmarks.md`](docs/benchmarks.md) |
| Building an agent on AWM as a substrate (PRIME → ACT → VERIFY → LEARN) | [`docs/patterns/awm-native-harness.md`](docs/patterns/awm-native-harness.md) · [agent playbook](https://completeideas.github.io/agent-working-memory/awm-for-agents.html) |
| Running it as a service; backup, restore, migration | [`docs/deployment.md`](docs/deployment.md) |
| Behaviour as the store grows | [`docs/using-awm-at-scale.md`](docs/using-awm-at-scale.md) |
| The vocabulary — engram, salience, activation, Hebbian, staging | [`docs/onboarding-vocabulary.md`](docs/onboarding-vocabulary.md) |
| When something is wrong | [`docs/troubleshooting.md`](docs/troubleshooting.md) |
| Full index | [`docs/README.md`](docs/README.md) |

**Stack:** TypeScript · SQLite + FTS5 (or PGlite / Postgres) · Fastify · `@modelcontextprotocol/sdk` ·
local ONNX via `@huggingface/transformers` — bge-small-en-v1.5 embeddings, ms-marco-MiniLM cross-encoder,
flan-t5-small expansion. Node 22+.

```bash
npx vitest run          # 760 tests
npm run eval            # benchmark suites
npm run test:docker     # clean-room install of the packed tarball
npm run test:linux      # build + full suite on Linux (760/760)
```

---

## Status

Active development, v0.14.6. Core retrieval, consolidation, MCP integration, hooks, task
management, and the HTTP API are stable and in daily production use. PGlite backend stable;
networked Postgres experimental. Real-store benchmark replaces LoCoMo as of 0.13.x.

**License:** Apache 2.0 — [LICENSE](LICENSE) · [NOTICE](NOTICE)
