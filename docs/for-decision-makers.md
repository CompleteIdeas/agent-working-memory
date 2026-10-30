# AWM for decision-makers

*For the technical manager who needs to understand this well enough to say yes or no —
not to build on it. Fifteen minutes. No cognitive science required.*

---

## The problem it solves, in one paragraph

An AI coding assistant forgets everything when the conversation ends. The next session
starts blank: it does not know what your team decided last week, which approach was tried
and rejected, or which database table actually holds the thing it is looking for. So it
re-derives all of that — reading files, running searches, asking you — every single time.
On a small task that is a minor tax. On a large project with months of history it means the
assistant is permanently a new hire on day one, and it will confidently rebuild something
that was already decided against.

AWM gives the assistant a memory that persists across sessions, decides for itself what is
worth keeping, and hands back the relevant piece when it is needed.

## What it is, mechanically

A small local program that runs alongside the AI assistant. It has two jobs:

1. **Write.** When the assistant learns something — a decision, a root cause, a fact about
   the system — it stores a short note. AWM scores each note for importance and discards the
   ones that are not worth keeping. Roughly a third of what is offered gets stored.
2. **Recall.** Before the assistant works on something, it asks AWM "what do I know about
   this?" and gets back the two or three most relevant notes. By default it returns the
   closest matches it has. With an opt-in gate switched on, it can instead say "this store
   most likely does not hold that" (see below).

Everything runs on the user's machine. One SQLite database file and three ML models
(about 600 MB total, downloaded once on first use — none of it is bundled in the package).
No cloud service, no API key, nothing leaves the box.
It plugs into Claude Code through the standard MCP protocol, and can also be used by any
agent over a local HTTP interface.

## What it demonstrably does

Every number below comes from a measurement that can be re-run from the repository. The
full record is in [`benchmarks.md`](benchmarks.md); the reasoning behind each is in the
dated files under [`archive/`](archive/README.md).

**Recall quality — does it return the right memory?**

| test | what it asks | result |
|---|---|---|
| Identifier fixture, 300 real queries | "Find the memory that contains this specific ticket number / table name / file" | **97.3%** in the top five, **92.7%** correct on the first result |
| Category fixture, 450 real queries | "Find the memory about this topic," phrased the way a person would | **96.9%** in the top five, **92.7%** first-result |

**A baseline belongs next to those numbers.** Plain keyword search (BM25) on the same questions
puts the right memory first for **95.7%** (identifier) and **91.6%** (topic). The fixtures are
keyword-friendly by construction, so they do not show AWM ranking better than keyword search.
What they do show is the cost of ignoring a memory's lifecycle: run over the raw store, with
replaced and retracted notes still in it, keyword search falls to 87.7% / 79.8% and puts an
outdated note first 8–15% of the time. Keeping track of which version of a fact is current
(supersession and retraction) is AWM's measurable edge.

The two fixtures are built differently and agree within a point. Both run against a frozen
copy of a real 30,000-memory store, not synthetic test data. The assistant sees the top three
by default, so the top-five figure is the one that describes what it gets; the first-result
figure is the stricter gauge used to catch ranking regressions. Both depend on memories being
written the way [`writing-memories.md`](writing-memories.md) says to, and that guidance applies
to any model, not only Claude.

**Effect on real work — does the assistant do better with it?**

A controlled test on four real support tickets: the same assistant, same tools, same
instructions, with and without memory. The arm with memory found **twice as many** of the
specific facts the real answer needed (57% vs 25%), and got there with **half the database
queries** (49 vs 100). On one ticket the memoryless arm ran 25 queries, exhausted its budget,
and produced no answer; the memory arm answered in 4 queries.

That is four tickets — directional, not statistically conclusive. It is reported at that
weight.

**Saying "I don't know" — opt-in, measured on one store**

By default AWM returns its closest matches even when the store does not hold the answer. An
earlier figure of "90% correctly return nothing" was measured with a strict setting nobody ships,
on 10 questions; with the default setting AWM stayed quiet on 0 of those 10. That figure has been
withdrawn.

An opt-in gate (`AWM_ABSTAIN_GATE=calibrated`) learns from the store itself what "no answer
here" looks like. Measured on the same real store, with keyword-style questions:

| question | result |
|---|---|
| 73 questions about facts that were never stored | **66** withheld |
| 694 questions whose answer is stored | **0** withheld, 4 answered with a warning |
| 200 questions about a deleted fact, asked in the vocabulary of its neighbours | 92 withheld, 30 answered with a warning |

It has not yet been measured on other stores or on natural-language questions. Method:
[`abstention.md`](abstention.md).

**Credentials — what happens to a password the assistant writes down**

- **Masked by default.** API keys, private keys, tokens and labelled passwords are masked before
  a note is stored, indexed or logged, so they are not replayed into later sessions. Detection is
  by shape and label; a bare random string with no label is not caught. Notes written before this
  shipped are not rewritten. [`redaction.md`](redaction.md)
- **Kept and usable, opt-in.** With the vault on (`AWM_VAULT=on`), a secret is encrypted in a
  separate file with the key in the operating system's credential store. The assistant can use it
  in a command you have allowed, without the value appearing in the conversation, and no tool
  returns the value to the model. [`vault.md`](vault.md)

**Where the value concentrates — long-horizon work**

On a large application project (EquiHub, ~20,000 memories over six months), 551 recorded
*decisions* were later recalled a median of **30 days** after being written, half of them
more than a month later, some up to **167 days**. On the main development session, 41% of
the technical identifiers the assistant used had entered the conversation *only* through a
memory recall — file paths, work-item numbers, table names it would otherwise have had to
rediscover.

This is the case that matters most. A support ticket has a database you can query if you
forget something. A design decision made in June has no such fallback; if it is not
remembered, it is silently re-decided.

## What it does not do

- **It is not a source of truth.** The code, the docs, and the tickets remain authoritative.
  AWM tells the assistant where to look and what was previously concluded; it does not
  replace looking.
- **It does not help small, one-off tasks.** Writing and reading memory has overhead. The
  benefit appears when knowledge is reused, or when the project is too large to hold in
  the assistant's context anyway.
- **Recall is only as good as what was written.** A note that omits the key identifier
  cannot be found by it later. The tooling nudges good writing; it cannot force it.
- **It is not a chatbot, a hosted service, or a generic vector database.**
- **Version 0.x.** Actively developed, honest about its limits, and the benchmark itself
  has been corrected three times this month when the instrument turned out to be wrong.
  Those corrections are documented in place rather than quietly revised.

## What saying yes commits you to

| | |
|---|---|
| **Install** | `npm install -g agent-working-memory && awm setup --global`, then restart Claude Code. About two minutes, plus a one-time ~600 MB model download that dominates it. |
| **Footprint** | One database file (a mature store is ~250 MB), three cached models (~600 MB), one lightweight background process per assistant session. |
| **Latency** | A recall takes about a quarter of a second once warm (p50 256 ms); the first one in a session can take a few seconds while models load. Not disruptive. |
| **Data** | Stays local. Separate memory pools per project or per person are supported. |
| **Lock-in** | The store is a plain SQLite file with a documented schema and an export command. |
| **Team use** | Several sessions can share one store safely; a multi-agent mode exists for automated pipelines. |
| **Reversal** | Uninstall the package and delete one file. Nothing else on the machine is touched. |

## The one-sentence version

AWM lets an AI assistant remember what your team decided and why, across months of work,
on your own machine. It returns the right memory first about 92% of the time on its
benchmark (plain keyword search manages about the same on those questions); what it adds is
knowing which version of a fact is current and, with an opt-in gate, saying when it does not
have the answer.

---

*Deeper reading, in order of technical depth:* [`walkthrough.md`](walkthrough.md)
(the mechanism, one memory followed end to end) → [`product-overview.md`](product-overview.md)
(what the system is, one page) → [`user-guide.md`](user-guide.md) (day-to-day use) →
[`architecture.md`](architecture.md) (how the pieces fit) →
[`cognitive-model.md`](cognitive-model.md) (the theory and its citations).
