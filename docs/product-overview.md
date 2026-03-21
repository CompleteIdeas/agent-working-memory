# AgentWorkingMemory — Product Overview

## What It Is

AgentWorkingMemory (AWM) is a cognitive memory layer for AI agents. It gives any LLM-based agent the ability to **remember**, **forget**, **learn from experience**, and **self-correct** across conversations. Instead of treating every interaction as a blank slate, AWM maintains a persistent, scored, and associatively-linked memory graph that surfaces the right information at the right time.

The system is built on established cognitive science — ACT-R base-level activation for temporal decay, Hebbian learning for association strengthening ("neurons that fire together wire together"), and hippocampal-inspired staging for uncertain memories. Three local ML models (embeddings, cross-encoder reranker, query expander) run entirely on-device with no external API calls.

## Who It's For

- **AI agent developers** building tools that need persistent, context-aware memory
- **Claude Code users** who want their coding assistant to remember project patterns, past decisions, and debugging solutions across sessions
- **Researchers** exploring cognitive memory architectures for autonomous agents

## Core Jobs-to-Be-Done

1. **Remember what matters** — Salience filtering automatically decides what's worth storing (active), what needs more evidence (staging), and what to discard
2. **Recall by context** — Given a natural language description of what you're working on, surface the most relevant memories ranked by text relevance, temporal recency, and associative strength
3. **Learn from feedback** — When a recalled memory is useful (or not), update its confidence score so the system improves over time
4. **Self-correct** — Retract wrong memories, create corrections, and automatically reduce confidence in associated memories that may also be contaminated
5. **Stay bounded** — Automatic eviction, edge pruning, and association decay prevent unbounded memory growth

## Glossary

| Term | Meaning |
|------|---------|
| **Engram** | A single memory unit — concept + content + metadata (confidence, salience, access count, tags, embedding) |
| **Activation** | The cognitive retrieval process — scoring memories against a context query using text, vector, temporal, and associative signals |
| **Salience** | Write-time importance score that determines if a memory is worth keeping |
| **Hebbian association** | A weighted edge between two memories strengthened each time they're co-activated |
| **Staging** | A buffer for uncertain memories — promoted to active if they resonate with existing knowledge, otherwise discarded |
| **Retraction** | Marking a memory as wrong, optionally creating a correction, and propagating confidence penalties to neighbors |
| **Eviction** | Removing the least valuable memories when capacity limits are reached |
| **Phase scores** | Per-phase breakdown of how each retrieval signal contributed to a memory's activation score |

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Language | TypeScript (ES2022, strict mode) | Type-safe cognitive engine |
| Database | SQLite via better-sqlite3 + FTS5 | Persistence, BM25 full-text search |
| HTTP Server | Fastify 5 | REST API for agents |
| MCP Server | @modelcontextprotocol/sdk | Direct Claude Code integration (9 tools via stdio) |
| Embeddings | Xenova/all-MiniLM-L6-v2 (~22MB ONNX) | 384-dim semantic vectors |
| Reranker | Xenova/ms-marco-MiniLM-L-6-v2 (~22MB ONNX) | Cross-encoder passage relevance |
| Query Expander | Xenova/flan-t5-small (~80MB ONNX) | Synonym/related term expansion |
| ML Runtime | @huggingface/transformers | Local ONNX inference (no API calls) |
| Test Framework | Vitest 4 | Unit and integration tests |
| Runtime | Node.js >= 20, tsx for dev | TypeScript execution |
| Validation | Zod 4 | MCP tool parameter schemas |

## Evidence

This overview was derived from:
- `package.json` — dependencies, scripts, metadata
- `src/index.ts`, `src/mcp.ts` — server entry points
- `src/core/` — cognitive model implementations
- `src/engine/activation.ts` — retrieval pipeline
- `src/types/engram.ts` — core data types
- `src/api/routes.ts` — HTTP endpoint definitions
