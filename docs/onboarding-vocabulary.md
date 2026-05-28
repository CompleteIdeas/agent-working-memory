# AWM Vocabulary — A First Read

AWM borrows its mechanics from cognitive science, and the vocabulary trips up
most readers on first contact. This page defines the seven terms you'll see
everywhere in the rest of the docs, in plain language, with a practical anchor.

If you're still confused about a term after reading the doc you came from,
this page is the place to look.

> **TL;DR.** AWM stores **engrams** (memory units). On write, a **salience**
> score decides whether the engram is *active* (visible to recall),
> *staging* (probationary), or discarded. On recall, **activation** ranks
> them — fading older ones via **ACT-R decay**, boosting co-recalled pairs
> via **Hebbian** edges. Periodically, **consolidation** ("sleep") clusters
> related memories, strengthens useful edges, and lets unused ones fade.
> Wrong memories get **retracted** with optional corrections. When the
> store hits capacity, **eviction** drops the least valuable.

---

## The seven core terms

### Engram
A single memory unit. Has a **concept** (a short label like "Use pgBouncer for
PostgreSQL pooling"), **content** (the full detail), and metadata
(confidence, salience, tags, an embedding, access count, timestamps).

If you've used a vector database, an engram is roughly "a row" — but with
considerably more state because AWM tracks how often it's accessed, how
trusted it is, and what other memories it's connected to.

> *Where you'll see this term:* `engram_id`, "active engrams," "engram pool."
> Every API response that returns memory rows calls them engrams.

### Salience
The **write-time importance score** in [0, 1]. AWM computes salience from
five inputs (event type, surprise, decision-made, causal depth, resolution
effort) plus a novelty check against existing memories.

The score gates whether the engram is **stored active** (≥ 0.4), placed
into **staging** for probation (≥ 0.2), or **discarded** outright (< 0.2).
You will see this score in `memory_write` responses; it's not a fixed
property — feedback can shift confidence over time, but salience is the
write-time gate.

> *Practical anchor:* If your `memory_write` returns
> `"disposition": "staging"`, salience was borderline. You can wait for the
> sweep to promote it, or rewrite the memory with more specificity (proper
> nouns, file paths, IDs) — that usually raises salience above the active
> threshold.

### Activation
The **retrieval process** — when you call `memory_recall` (or
`POST /memory/activate`), AWM runs a 10-phase pipeline that scores every
candidate engram against your context query. The phases combine keyword
search (BM25), vector similarity, temporal decay, association boosts, and
a final cross-encoder rerank.

The output is a ranked list with per-phase scores in the `phaseScores`
field, so you can see *why* a memory ranked where it did.

> *Practical anchor:* When debugging "why didn't recall surface X?" — look
> at `phaseScores` on related engrams. Low `textMatch` means BM25 didn't
> hit; low `vectorMatch` means the embedding doesn't see the link; high
> `rerankerScore` on irrelevant results means a reranker noise issue.

### Hebbian association
A **weighted edge** between two engrams, named after the neuroscience
principle "neurons that fire together, wire together." Each time two
engrams are recalled in the same query, their edge weight increases. Edges
that aren't used decay over time (default half-life: 7 days).

Hebbian edges power the **graph walk** during retrieval — once a top result
is identified, AWM walks two hops out along its strong edges to surface
related context that wouldn't have hit on keyword/vector alone.

> *Practical anchor:* This is what makes AWM more than RAG. If you ask
> "how does our auth work?" and AWM also surfaces "we deprecated JWT for
> sessions because tokens leaked in the proxy logs" — that second memory
> won out because Hebbian edges had connected the two on previous queries.

### Staging
The **probationary buffer** for borderline-salience engrams (score
0.2-0.4). Staging engrams aren't returned by default recalls, but they're
considered during consolidation. If a staging engram **resonates** with
existing knowledge (gets a graph link, or its concept matches another
memory's tags), it gets promoted to active. If it sits unused, it gets
swept after 24 hours.

> *Practical anchor:* Staging is how AWM avoids both extremes — it doesn't
> reject low-confidence memories outright, but it also doesn't pollute
> recall with them until they prove their worth.

### Consolidation
The **sleep cycle.** Triggered on session end and on a schedule. Seven
phases: cluster related engrams, strengthen access-weighted edges, form
cross-topic bridges, decay unused edges, normalize hub weights, archive
low-confidence memories, sweep staging. This is when "noise becomes
signal" — the system gets cleaner with sleep.

> *Practical anchor:* If memory feels stale after long sessions, run
> `POST /system/decay` or wait for the next consolidation. Behavior of an
> AWM instance after 100 consolidation cycles is markedly different from
> one that just started — connections firm up, noise fades.

### Retraction
**Marking an engram as wrong**, optionally with a correction. Retraction
is not deletion — the retracted engram stays in the database for
audit/history, but it's filtered from recall. Crucially, retraction
**propagates**: confidence penalties flow along Hebbian edges, scaled by
local cluster cohesion (so retracting a fact in a tight narrative
penalizes neighbors more heavily than retracting a fact in a hub).

If you supply `counterContent`, AWM creates a correction engram, links
them, and the correction inherits the wrong engram's edges (scaled 0.7×)
so the corrected version takes over the graph role.

> *Practical anchor:* Use retract instead of delete when memory turns out
> to be wrong. The penalty propagation helps recall avoid related
> contamination; counter-content gives the agent a fact to recall *in
> place of* the wrong one.

---

## A few more you'll bump into

| Term | Meaning |
|------|---------|
| **Eviction** | Capacity enforcement. When you hit `maxActiveEngrams` (default 10,000), the lowest-utility engrams (low confidence × low access) get archived. |
| **Phase scores** | The per-signal breakdown of an activation result. Shown in `phaseScores` on every recall hit. The reason "I ranked X above Y" is in this object. |
| **Memory class** | A property on each engram. `canonical` (source of truth, 0.7 salience floor, never staged), `working` (default — salience-gated), `ephemeral` (decays fast), `structural` (system-written records, excluded from semantic recall by default). |
| **Slim cache** | An in-memory index of every engram's `(id, concept, embedding)` for fast recall. Populated at server startup. Disable with `AWM_DISABLE_SLIM_CACHE=1` if you suspect cache drift. |
| **Workspace** | A scoping mechanism that lets multiple agents share a memory pool while still defaulting to their own subset. Set `AWM_WORKSPACE` to opt in. |
| **Reranker** | The cross-encoder model (ms-marco-MiniLM) that runs at the end of recall to refine the top-K ordering. Disable per-call with `useReranker: false` for fast/low-quality. |
| **Abstention** | Opt-in: pass `requireConfidence: 0.25` on recall to make AWM return `[]` (instead of best-of-bad-bunch) when the score distribution looks weak. |

---

## What this *isn't*

These terms describe AWM's mechanics, not what the user does. You don't
"write a salience" — the system computes salience from what you wrote. You
don't "activate" a memory directly — you describe a context, and the
activation pipeline ranks candidates.

The mental model that works: you give AWM short, well-tagged observations
("memory_write"). It scores them, files them, and surfaces relevant ones
when you give it a context ("memory_recall"). Everything else — staging,
consolidation, retraction, eviction — is housekeeping that AWM runs to
keep recall sharp over time.

For deeper grounding (ACT-R, Hebbian learning, complementary learning
systems, synaptic homeostasis), see [`cognitive-model.md`](cognitive-model.md).

For "I read this and now what?" — the natural next read is
[`quickstart.md`](quickstart.md) (install + first write/recall) or
[`how-to.md`](how-to.md) (task recipes by goal).
