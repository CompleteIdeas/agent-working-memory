# How AWM works — a walkthrough

*For the technical manager who wants to understand the mechanism, not just the pitch.
This follows one memory from the moment it is written to the moment it is corrected, and
explains each piece by what it does before giving it a name. Thirty minutes. Every number
is taken from the current source or a recorded measurement.*

> If you only need to decide yes or no, [`for-decision-makers.md`](for-decision-makers.md)
> is shorter. This page is for "walk me through it."

---

## The setup

An AI coding assistant is working a support ticket. It has just learned something worth
keeping: a particular database report misses riders whose membership was digital-only,
and the fix involves a function called `fn_member_valid_on_date`. Without AWM, that
knowledge exists only in this conversation and dies with it. With AWM, four things happen.

## 1. The assistant writes a memory

It calls one tool, `memory_write`, with a short label and the detail:

```
concept: "Invalid Membership report misses Digital-only members"
content: "The report filters on fn_member_valid_on_date, which excludes members
          whose only membership is Digital. Ticket 19445. Affects Starter division."
tags:    ticket=19445, topic=invalid-membership-report, project=USEA
```

That is the whole write. The assistant does not decide whether it is important — AWM does.

**What AWM stores** is that text plus bookkeeping it maintains itself: a numeric
fingerprint of the meaning (an *embedding*, 384 numbers), a confidence score, an
importance score, how many times it has been recalled, when it was created and last used,
and which agent owns it. The unit is called an **engram** — the neuroscience word for the
physical trace a memory leaves. Think of it as a row with a lot of state attached.

## 2. AWM decides whether it is worth keeping

Before storing, AWM scores the write for importance. This is the first thing that makes it
different from a database: **it refuses most of what it is offered.**

The score, called **salience**, comes from a few signals:

- **Is it new?** AWM searches what it already holds for near-duplicates. An exact repeat
  scores near zero; genuinely new information scores high. This one check does most of
  the work.
- **What kind of event is it?** A decision, a root cause, or a failure that took effort to
  resolve scores higher than a passing observation. The assistant can label the write
  (`event_type: causal`, `decision_made: true`) and the label carries weight.
- **Does it name things?** Identifiers — a ticket number, a function name, a file path —
  raise the score, because a memory that names its subject can be found again.

The score lands the write in one of three places:

| salience | disposition | what happens |
|---|---:|---|
| ≥ 0.4 | **active** | stored, visible to recall immediately |
| 0.2 – 0.4 | **staging** | held in a probationary area; promoted if later evidence supports it, otherwise swept after 30 days |
| < 0.2 | **low-salience** | kept at reduced confidence so it is not lost, but effectively invisible to recall |

On the live store this is not theoretical: **about one third** of everything ever offered
is active at full confidence. The other two thirds were judged not worth surfacing. That
selectivity is why recall stays sharp as the store grows — noise never gets in.

There is one override. A write marked `memory_class: canonical` — a stated decision, a
verified fact, something other agents must be able to find — is given a salience floor of
0.7 and never stages. That is how the assistant says "this one matters; do not gate it."

Our example write names a ticket, a function, and a root cause. It scores well above 0.4
and goes active.

## 3. Someone asks a question, and AWM recalls

Three days later, a different session — no shared context, maybe a different developer —
is working ticket 19449 about the same report. The assistant calls `memory_recall` with a
plain description of what it is doing:

```
"Invalid Membership report Starter division digital members"
```

AWM now has to find the right memory among ~30,000. It does this in stages, and the order
matters:

**Cast a wide net, two ways.** A keyword search (the same technique search engines use,
called BM25) finds memories that share words with the query. In parallel, a *meaning*
search compares the query's embedding against every stored embedding and finds memories
that are about the same thing even if the words differ. The two lists are merged into a
candidate pool of a few dozen.

**Score each candidate.** Every candidate gets points for keyword overlap, for meaning
similarity, and — this is the second thing that makes AWM different — for **how alive it
is**. A memory recalled often and recently scores higher than one nobody has touched in
months. This is borrowed directly from a well-tested model of human memory (ACT-R), and it
means the store *forgets gracefully*: old, unused memories do not vanish, they just stop
winning.

**Let the connected memories vote.** If two memories have been recalled together before,
AWM has drawn a link between them and strengthened it each time. When one of them is a
strong candidate, its linked neighbours get a small boost. Over months this builds a graph
of "things that go together" that no one designed. (Measured honestly: on the current
benchmark the reranker below makes the final call and this stage rarely changes the top
result. It is kept because the links themselves are useful state; see the limitations doc.)

**Re-read the top candidates properly.** The stages above are fast and approximate. The
final stage hands the top few dozen to a small model — a *cross-encoder* — that reads the
query and each candidate together and produces a relevance judgment. This is expensive per
item, which is why it only runs on the shortlist, and it decides the final order.

One detail here is the kind of thing that only shows up in real use. Real memories are
long — the median is about 2,000 characters — and the cross-encoder can only read 400. For
a long time AWM handed it the *first* 400, and the identifier that mattered was usually
further down. It now hands it the 400-character window densest in the query's own terms,
plus the memory's tags. That one change moved recall on long memories from 25% to 87.5%.

**Decide whether to answer at all.** This is the third difference. Before returning
results, AWM looks at the *shape* of the scores. If the best candidate is only slightly
better than the tenth, the query probably has no good answer in the store, and AWM returns
nothing — with a message saying how many candidates it withheld and why. The threshold is
deliberately light by default (it halves off-topic answers at no cost to real ones). The
benchmark scores this correct silence as a *win*: on ten questions about facts that were
never stored, AWM stays quiet on nine.

For our query, the top result is the memory written in step 1. It arrives as:

```
1. **Invalid Membership report misses Digital-only members** (0.61) [id: 4760bd43-…]
   The report filters on fn_member_valid_on_date, which excludes members whose
   only membership is Digital. Ticket 19445. Affects Starter division.
[recall_id: 7c2e…]
```

The second session now knows the function name and the root cause without reading a line
of code. That is the transfer. Measured on a real six-month project: **41% of the technical
identifiers the assistant used had entered the conversation only through a recall.**

## 4. The system learns from what happened

Two things follow the recall, and neither requires the assistant to do anything special.

**The memory gets stronger.** Its access count goes up and its last-used time resets, so
in step 3's liveness scoring it now outranks its peers. Memories that keep being useful
keep being found.

**The link forms.** If the assistant also recalled a second memory in the same query — say,
the ticket 19449 note — AWM records that the two were used together. Next time either one
is a strong candidate, the other gets a nudge. This is the graph from step 3, being built.

And if the assistant reports back — `memory_feedback: useful` with the `recall_id` from
the output — the memory's confidence rises and the links it was recalled with are
strengthened further. Feedback is optional; the system works without it, and works better
with it.

## 5. Time passes, and the store tidies itself

When a session ends, or after five idle minutes, AWM runs a maintenance pass it calls
**consolidation** — deliberately named after what the brain does during sleep. It:

- clusters memories about the same thing and links them
- weakens links that have not been used (half-life 7 days; up to 30 for high-confidence
  memories)
- prevents any one heavily-linked memory from dominating every query
- archives memories that are low-confidence, rarely accessed, and old
- promotes or sweeps whatever is sitting in staging

Nothing here is deleted. Archived and swept memories remain in the database and can be
found by direct search; they just stop competing in recall. The store has a hard cap of
10,000 *active* memories per agent; the live store sits at about 8,000.

## 6. The fact changes

A week later, someone verifies against the live database and finds the earlier note was
slightly wrong: the report excludes Digital-only *and* Community-only members. The
assistant writes the corrected version and marks it as replacing the old one:

```
memory_write(concept: "Invalid Membership report misses Digital-only AND Community-only",
             content: "...", supersedes: 4760bd43-…)
```

The old memory is not deleted. It is marked **superseded**, linked to its replacement, and
from then on if it ever surfaces in a recall it carries a visible warning:

```
⚠ SUPERSEDED by 9f1a… — treat as historical; recall/fetch the successor before relying on this.
```

This is the mechanism a file of notes cannot provide. In a text file the old paragraph and
the new one sit side by side and read with equal confidence. Here the store *knows which
one won*. On the live store, 108 memories in one project have been superseded this way as
decisions evolved — and an agent resuming that project gets one current state, not five.

If a memory is simply *wrong* rather than outdated, `memory_retract` marks it invalid and
reduces confidence in the memories most closely linked to it, on the theory that whatever
led to the error may have contaminated its neighbours.

## Where the memory lives, and who can see it

Everything above happens inside one SQLite file on the user's machine — about 250 MB for
a mature store — plus three small ML models (~200 MB, downloaded once) that run locally.
Nothing is sent anywhere.

Memories are owned by an **agent**, and recall is scoped to the caller's agent. On one
machine there are typically two: `work` and `personal`. A work session cannot see personal
memories, and vice versa. Several sessions can share one agent's store at the same time;
the database handles concurrent access safely. A team or multi-agent pipeline can opt into
a shared **workspace** so specialised agents read from a common pool.

## What all this adds up to

| the design choice | what it buys |
|---|---|
| refuse most writes (salience) | recall stays sharp as the store grows; ~2/3 of offered content never competes |
| score liveness, not just relevance (ACT-R decay) | the store forgets gracefully without anyone curating it |
| link what is used together (Hebbian edges) | related context surfaces without being asked for |
| re-read the shortlist with a small model (reranker) | the final order is based on actually reading the text |
| return nothing when nothing fits (abstention) | a wrong confident answer is more expensive than an admitted gap |
| mark replaced facts rather than deleting them (supersede) | the store knows what changed; a notes file does not |
| keep it local and per-agent | no data leaves the box; work and personal never mix |

Measured, on a frozen copy of a real 30,000-memory store: the right memory is the **first**
result **92.7%** of the time on identifier queries and **92.0%** on topic queries, in the
top five about 97% of the time, and the system correctly stays silent on 90% of questions
it has no answer to. Warm recall takes about half a second.

## What it does not do, stated plainly

- It does not replace reading the code. The intended loop is: recall first, verify
  against the source when it matters, supersede when reality differs.
- Recall is only as good as the write. A memory that never names its subject cannot be
  found by it. The writing guidance exists for this reason.
- The link graph, as of the current release, rarely changes a final answer — the reranker
  does that. The graph's value is in the state it accumulates, not in today's ranking.
- Small one-off tasks do not benefit. The overhead of writing and recalling pays back when
  knowledge is reused or when the project outgrows what fits in the assistant's context.
- It is version 0.x and honest about it: the benchmark itself has been corrected three
  times this month when the instrument, not the engine, turned out to be wrong.

The full list is in [`known-limitations.md`](known-limitations.md).

---

*Next, by depth:* [`onboarding-vocabulary.md`](onboarding-vocabulary.md) (the terms, one
paragraph each) → [`user-guide.md`](user-guide.md) (day-to-day use) →
[`architecture.md`](architecture.md) (how the processes fit) →
[`cognitive-model.md`](cognitive-model.md) (the theory and its citations) →
[`benchmarks.md`](benchmarks.md) (how every number above was measured).
