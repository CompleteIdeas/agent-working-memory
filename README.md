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

Reproducible from this repository against a frozen copy of a **real 30,000-memory store**, not
synthetic data. Current numbers, stamped with the commit that produced them:
[`docs/benchmarks-current.md`](docs/benchmarks-current.md).

| | |
|---|---|
| **Returns the right memory first** | **92.7%** of identifier queries · **92.0%** of topic queries · **96.7%** in the top five |
| **Stays silent when it should** | **90.0%** correct abstention on questions about facts never stored |
| **Costs the same at any scale** | Scoped recall answers in **~630 tokens flat**. Carrying the store instead: ~1.3M tokens |
| **Lets a cheap model punch up** | Small model + AWM beat a frontier model on a 15-task domain workload: **14/15 vs 7/15**, at ~1/40th the cost |

Two independently built fixtures agree within a point. Warm recall takes about half a second.

<details>
<summary>Two more, from real work rather than fixtures</summary>

**Halves the digging.** Same agent, same tools, four real support tickets: with memory, 2× the
specific facts the real answer needed and half the database queries (49 vs 100). On one ticket
the memoryless arm ran 25 queries, exhausted its budget and answered nothing; the memory arm
answered in 4.

**Holds decisions for months.** On a six-month application project, recorded decisions were
recalled a median of 30 days after being written — some after 167. 41% of the technical
identifiers the agent used had entered the conversation *only* through a recall.
</details>

---

## Is this for you?

The honest version, because the overhead is real and it does not pay back for everyone.

| If you are… | What you actually get | It pays back when |
|---|---|---|
| **A solo developer on one long-lived project** | The agent stops re-asking what you already told it, and stops re-proposing approaches you rejected | The project outgrows the context window — roughly, when you start saying "I have explained this before" |
| **A team sharing conventions** | One pool where a decision written by anyone is recalled by everyone, with corrections superseding rather than accumulating | More than one person is steering agents at the same codebase |
| **Running support or operations agents** | Ticket-scoped recall by real identifiers, so the second agent to touch a ticket knows what the first one did | Work arrives as a queue that several sessions or people share |
| **Building multi-agent pipelines** | A shared substrate with per-agent scoping, so specialists cooperate without sharing one context window | You have specialised agents that need the same facts |
| **Cost-constrained** | A small local model with good recall beats a frontier model without it on domain work | Your workload is narrow and repetitive rather than novel each time |
| **Somewhere cloud memory is not allowed** | One SQLite file on the machine. No account, no telemetry, no egress | Compliance makes hosted memory a non-starter |

**Skip it if:** your tasks are short and one-off with nothing worth reusing; you want a hosted
service someone else operates; you need memory synced across machines out of the box; or you were
hoping to replace your code, tickets and docs as the source of truth. AWM is a fast path back to
what was already decided — recall first, verify against the source when it matters, supersede when
reality differs.

It is also **not** a chatbot, a generic vector database, or a RAG pipeline over your files.

---

## Get started

```bash
npm install -g agent-working-memory
awm setup --global          # MCP config, CLAUDE.md guidance, hooks
```

Or install it as a Claude Code plugin instead, which wires the same things without a setup
step and upgrades with `/plugin update`:

```
/plugin marketplace add CompleteIdeas/agent-working-memory
/plugin install awm@agent-working-memory
```

Both share one store at `~/.awm/memory.db`, so it is a preference, not a fork — the
trade-offs are in [`docs/plugin.md`](docs/plugin.md). Install the npm package either way.

Requires **Node.js 22+**. Restart Claude Code.

**What to expect.** The first conversation is ~30 s slower while three small ONNX models download
(~200 MB, once). After that the agent has 19 memory tools, and the hooks save state on compaction
and session end without you doing anything. For the first day or two recall will be thin — it only
knows what has been written. That is the normal shape of it, not a fault.

**Starting on an existing project?** Warm-start the store from its own docs so recall is useful on
day one:

```bash
awm onboard ./docs --repo . --project <name>    # review the pack, then
awm import <pack> --db <path> --dedupe
```

**Turn on the three retrieval improvements.** They ship default-off and belong together:

```bash
AWM_RERANK2=1 AWM_RERANK_WINDOW=query AWM_RERANK_TAGS=1
```

Second-stage rerank by the cross-encoder's own score; a 400-character rerank window placed on the
densest query-term region rather than the prefix (**25% → 87.5%** on long memories); and tags fed
into the rerank passage (**+7.4pp**). `awm setup` writes them on a fresh install. `memory_whoami`
prints the active fingerprint so you can confirm a running process has them.

**Check it worked:** `awm doctor claude-code` reports the live sidecars, which agent each serves,
and whether anything needs a re-run of setup.

| Next | |
|---|---|
| Install, first write, first recall | [`docs/quickstart.md`](docs/quickstart.md) |
| Separate pools per project, incognito mode, hooks | [`docs/claude-code-setup.md`](docs/claude-code-setup.md) |
| As a Claude Code plugin | [`docs/plugin.md`](docs/plugin.md) |
| Teams and multi-agent | [`docs/team-setup-guide.md`](docs/team-setup-guide.md) |
| Custom agents over HTTP | [`docs/reference.md`](docs/reference.md) |

---

## Why it works when a vector store doesn't

Most "memory for AI" stores everything and retrieves by similarity. AWM makes the opposite bet:
**a memory is only useful if it is selective.**

**It refuses most of what it sees.** Every write is scored for importance before storage — is it
new, is it a decision or a root cause, does it name its subject? About a third of what the agent
offers is kept at full confidence. The rest never competes, so recall stays sharp as the store
grows.

**It forgets gracefully.** Memories that keep getting used stay strong; ones nobody touches fade
from ranking without being deleted. The model is borrowed from cognitive science (ACT-R), and it
means no one curates the store.

**It tells you when it doesn't know.** When the top candidates are only marginally better than the
tenth, AWM returns nothing and says how many it withheld. A confident wrong memory is more
expensive than an admitted gap — the benchmark scores the silence as a win.

**It knows what changed.** When a fact is corrected, the old memory is marked superseded and
carries a visible warning if it ever surfaces. A notes file has two paragraphs that read with equal
confidence; AWM knows which one won. One project has 108 such supersessions — an agent resuming it
gets one current state, not five.

**It stays local and per-person.** One SQLite file, three small ONNX models. Work and personal
memories are separate pools; several sessions share a pool safely.

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

## How it works, in one paragraph

A write is scored for salience — novelty against the existing store, event type, whether it names
identifiers — and lands active, staged, or low-confidence. A recall casts a wide net with keyword
and vector search, scores each candidate for relevance and liveness, lets linked memories vote,
hands the shortlist to a cross-encoder that actually reads the text, then checks whether the score
distribution justifies answering at all. A maintenance pass on session end clusters, decays unused
links, and archives what has gone cold. Corrections supersede rather than overwrite.

The whole thing, one memory followed end to end with every threshold sourced:
[`docs/walkthrough.md`](docs/walkthrough.md). The mental model an engineer needs to predict its
behaviour — proposers, deciders, and when it stays silent:
[`How AWM decides what to say`](https://completeideas.github.io/agent-working-memory/pipeline-walkthrough.html).
The theory and its citations: [`docs/cognitive-model.md`](docs/cognitive-model.md).

---

## Honest limits

- No help on small one-off tasks — the overhead pays back when knowledge is reused or the project
  outgrows the context window.
- Recall is bounded by what was written. A memory that never names its subject cannot be found by
  it. The writing guidance exists for this reason.
- The association graph, as of this release, rarely changes a final answer; the reranker does.
- It is 0.x. Benchmark figures have been corrected upward more than once after the *instrument*
  turned out to be wrong; every correction is documented in place rather than revised away.

Everything else, with evidence and workarounds: [`docs/known-limitations.md`](docs/known-limitations.md).

---

## Reference

The README points outward; it does not duplicate. Everything below is the authoritative source.

| | |
|---|---|
| **All 19 MCP tools**, every HTTP endpoint with schemas, every environment variable with its measured effect | [`docs/reference.md`](docs/reference.md) |
| Architecture, pipelines, schema, backends (SQLite · PGlite · Postgres) | [`docs/architecture.md`](docs/architecture.md) · [`docs/pglite-feature-parity.md`](docs/pglite-feature-parity.md) |
| Current benchmark numbers, generated and stamped | [`docs/benchmarks-current.md`](docs/benchmarks-current.md) |
| What each eval suite measures, and the measurement caveats | [`docs/benchmarks.md`](docs/benchmarks.md) |
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
npx vitest run          # 769 tests
npm run bench           # benchmark suites
npm run build:plugin    # regenerate the Claude Code plugin from src/
npm run test:docker     # clean-room install of the packed tarball
npm run test:linux      # build + full suite on Linux (769/769)
```

---

## Status

Active development, v0.15.1. Core retrieval, consolidation, MCP integration, hooks, task
management, and the HTTP API are stable and in daily production use. PGlite backend stable;
networked Postgres experimental.

Release notes, and every benchmark correction recorded against the release that made it:
[CHANGELOG.md](CHANGELOG.md).

**License:** Apache 2.0 — [LICENSE](LICENSE) · [NOTICE](NOTICE)
