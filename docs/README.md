# AWM documentation

Start with the [README](../README.md) for what AWM is and how to run it. This index
covers everything else.

## Start here

| Doc | What it covers |
|---|---|
| [quickstart.md](quickstart.md) | Install, first write, first recall |
| [product-overview.md](product-overview.md) | What the system is for, in one page |
| [user-guide.md](user-guide.md) | Day-to-day use: when to write, when to recall |
| [how-to.md](how-to.md) | Task-shaped recipes |
| [faq.md](faq.md) | Common questions |
| [onboarding-vocabulary.md](onboarding-vocabulary.md) | The terms AWM uses and what they mean |

## Setup

| Doc | What it covers |
|---|---|
| [claude-code-setup.md](claude-code-setup.md) | MCP wiring, hooks, agent identity |
| [team-setup-guide.md](team-setup-guide.md) | Multi-agent / hive configuration |
| [deployment.md](deployment.md) | Running it as a real service |

## Reference

| Doc | What it covers |
|---|---|
| **[reference.md](reference.md)** | **The complete reference** — every HTTP endpoint with schemas, every environment variable with its measured effect, hook config, configuration defaults. Includes the flag experiments that were **rejected**, and why. |
| [coordination-api.md](coordination-api.md) | Hive coordination endpoints |
| [benchmarks.md](benchmarks.md) | Every eval suite: what it measures, how it scores, how to run it |
| [architecture.md](architecture.md) | How the pieces fit together |
| [cognitive-model.md](cognitive-model.md) | ACT-R decay, Hebbian edges, salience — the theory and its citations |

## Operating it

| Doc | What it covers |
|---|---|
| [troubleshooting.md](troubleshooting.md) | When something is wrong |
| [known-limitations.md](known-limitations.md) | What it does not do well, stated plainly |
| [using-awm-at-scale.md](using-awm-at-scale.md) | Behaviour as the store grows |
| [telemetry-recommendations.md](telemetry-recommendations.md) | What to instrument |
| [traceability.md](traceability.md) | Following a result back to its cause |

## Design records

| Doc | What it covers |
|---|---|
| [awm-architecture-history.md](awm-architecture-history.md) | How the architecture got here |
| [memory-quality-hardening-rfc.md](memory-quality-hardening-rfc.md) | The write-quality RFC |
| [pglite-feature-parity.md](pglite-feature-parity.md) | SQLite vs PGlite backend parity |
| [layer-review-report.md](layer-review-report.md) | Layer-by-layer review |
| [pilot-feedback-report.md](pilot-feedback-report.md) | Findings from pilot use |
| [ux-map.md](ux-map.md) | The tool surface as a user encounters it |
| [unknowns.md](unknowns.md) | Open questions |

## [archive/](archive/README.md) — dated investigations

Point-in-time records of experiments, with what each one concluded. **Read
[the archive index](archive/README.md), not the files** — several contain
recommendations that later measurement overturned, and the index says which.

Nothing there is maintained, and nothing there was deleted: a refuted hypothesis is
the record that stops it being re-proposed a fourth time.

---

## Where things belong

So this stays navigable as it grows:

- **[README](../README.md)** — what AWM is, how to start, what changed, what it scores.
  The front door. Points outward; does not duplicate.
- **[reference.md](reference.md)** — current behaviour, exhaustively. Every endpoint,
  every flag, every default. If a flag exists, it is documented here.
- **[CHANGELOG.md](../CHANGELOG.md)** — release history. What changed, when, and why.
- **[benchmarks.md](benchmarks.md)** — how each suite measures and how to run it.
- **[archive/](archive/README.md)** — dated evidence. Never edited after the fact;
  superseded conclusions are flagged in the index rather than rewritten.

A number that appears in two places will drift. Prefer a pointer.
