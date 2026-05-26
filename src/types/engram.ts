// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Engram — the fundamental unit of agent memory.
 *
 * An engram represents a single memory trace with salience metadata,
 * staging lifecycle, retraction support, and optional task management.
 */

export interface Engram {
  id: string;
  agentId: string;
  concept: string;
  content: string;
  embedding: number[] | null;

  // Cognitive scores
  confidence: number;    // 0-1 Bayesian posterior — updated on retrieval feedback
  salience: number;      // Write-time importance score
  accessCount: number;   // For ACT-R decay calculation
  lastAccessed: Date;
  createdAt: Date;

  // Salience audit trail
  salienceFeatures: SalienceFeatures;
  reasonCodes: string[];

  // Lifecycle
  stage: EngramStage;
  ttl: number | null;    // Milliseconds — only for staging buffer entries

  // Negative memory
  retracted: boolean;
  retractedBy: string | null;   // ID of the engram that invalidated this one
  retractedAt: Date | null;

  // Tags for concept-based retrieval
  tags: string[];

  // Episode grouping
  episodeId: string | null;

  // Memory class
  memoryClass: MemoryClass;

  // Memory type (content classification)
  memoryType: MemoryType;

  // Optional story-time / sequence ordering (0.8 Cluster A). NULL for engrams
  // without a caller-supplied sequence. Used by `sortBy: "sequence"` on search
  // and by /memory/latest-by-tag (0.8 Cluster C).
  sequence: number | null;

  // Typed references to other engrams (0.8 Cluster A schema; wired to HTTP
  // in Cluster D). Stored as JSON in references_json column.
  references: EngramReference[] | null;

  // Supersession — "this replaces that" (not retraction — original wasn't wrong, just outdated)
  supersededBy: string | null;   // ID of the engram that replaced this one
  supersedes: string | null;     // ID of the engram this one replaces

  // Task management (null = not a task)
  taskStatus: TaskStatus | null;
  taskPriority: TaskPriority | null;
  blockedBy: string | null;   // ID of blocking engram/task
}

export type EngramStage = 'staging' | 'active' | 'consolidated' | 'fading' | 'archived';

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done';
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

/**
 * Memory class — controls salience floor and recall priority.
 *
 * canonical:  Source-of-truth facts (current state, decisions, architecture).
 *             Never goes to staging. Minimum salience 0.7.
 * working:    Normal observations, learnings, context (default).
 *             Standard salience rules apply.
 * ephemeral:  Temporary context (debugging traces, session-specific notes).
 *             Stronger time decay, lower recall priority.
 */
/**
 * Memory class — write-time classification controlling salience behavior
 * and downstream retrieval semantics.
 *
 * canonical:  Source-of-truth memories. Salience floor 0.7, never stage.
 *             Surfaced via cognitive `/activate` and deterministic queries.
 *
 * working:    Default. Observations, findings, progress notes. Standard
 *             salience rules apply. Surfaced via all retrieval paths.
 *
 * ephemeral:  Temporary context. Stronger time decay, lower recall priority.
 *
 * structural: (0.8+) System-written event-log records — chapter analyses,
 *             promise advancements, materialized-view feeds. Salience floor
 *             0.7 like canonical, but EXCLUDED from cognitive `/activate`
 *             by default (callers opt in via `includeStructural: true`),
 *             skip temporal-adjacency edges, skip default embedding. Used
 *             for high-volume deterministic substrate where cognitive
 *             retrieval would just add noise.
 */
export type MemoryClass = 'canonical' | 'working' | 'ephemeral' | 'structural';

/**
 * Typed cross-record link stored alongside an engram in references_json.
 * Wired through HTTP in 0.8 Cluster D; schema slot added in Cluster A.
 */
export interface EngramReference {
  type: 'advances' | 'resolves' | 'subverts' | 'abandons' | 'extends' | 'supersedes';
  /** ID of the referenced engram. Either this or matchConcept must be set. */
  matchEngramId?: string;
  /** Concept of the referenced engram (resolved at write time in 0.8 D). */
  matchConcept?: string;
}

/**
 * Memory type — content classification for retrieval routing.
 *
 * episodic:      Events, incidents, debugging sessions ("we did X because Y").
 * semantic:      Facts, decisions, patterns ("X is true", "we use Y for Z").
 * procedural:    How-to, steps, processes ("to deploy, run X then Y").
 * unclassified:  Default for backwards compatibility.
 */
export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'unclassified';

/**
 * Raw feature scores that produced the salience score.
 * Persisted for auditability and tuning.
 */
export interface SalienceFeatures {
  surprise: number;
  decisionMade: boolean;
  causalDepth: number;
  resolutionEffort: number;
  eventType: string;
}

export interface EngramCreate {
  agentId: string;
  concept: string;
  content: string;
  tags?: string[];
  embedding?: number[];
  salience?: number;
  confidence?: number;
  salienceFeatures?: SalienceFeatures;
  reasonCodes?: string[];
  episodeId?: string;
  ttl?: number;
  memoryClass?: MemoryClass;
  memoryType?: MemoryType;
  supersedes?: string;
  taskStatus?: TaskStatus;
  taskPriority?: TaskPriority;
  blockedBy?: string;
  /** Optional story-time / sequence ordering (0.8 Cluster A). */
  sequence?: number;
  /** Typed cross-record links (0.8 Cluster A schema; HTTP in Cluster D). */
  references?: EngramReference[];
}

/**
 * Association — weighted edge between two engrams.
 * Strengthened by Hebbian co-activation, decays when unused.
 * Capped at MAX_EDGES_PER_ENGRAM to prevent graph explosion.
 */
export interface Association {
  id: string;
  fromEngramId: string;
  toEngramId: string;
  weight: number;            // Log-space, updated via Hebbian rule
  confidence: number;        // Edge-level confidence (separate from node)
  type: AssociationType;
  activationCount: number;   // How many times this edge contributed to retrieval
  createdAt: Date;
  lastActivated: Date;
}

export type AssociationType = 'hebbian' | 'connection' | 'causal' | 'temporal' | 'invalidation' | 'bridge';

export const MAX_EDGES_PER_ENGRAM = 20;

/**
 * Activation result — returned from the activation pipeline.
 */
export interface ActivationResult {
  engram: Engram;
  score: number;
  phaseScores: PhaseScores;  // Per-phase breakdown for explainability
  why: string;               // Human-readable explanation
  associations: Association[];
  /**
   * Recall confidence — score-distribution-aware signal in [0, 1].
   * Same value on every result in the same recall (it describes the
   * *set*, not the individual). Computed once after final ranking.
   * See `src/engine/confidence.ts` for the formula.
   */
  confidence?: number;
  /**
   * Confidence-adaptive content preview (Paper 3: cognitive teaming).
   * Set when the query opts in via `granularity: 'compact' | 'auto'`.
   * Trades depth for breadth — short when the agent should scan a diverse
   * set, full when there is a clear winner worth absorbing in full.
   */
  summary?: string;
}

/**
 * Per-phase scoring breakdown — full audit of how each phase contributed.
 */
export interface PhaseScores {
  textMatch: number;
  vectorMatch: number;
  decayScore: number;
  hebbianBoost: number;
  graphBoost: number;
  confidenceGate: number;
  composite: number;
  rerankerScore: number;   // Cross-encoder relevance (0-1), 0 if reranker disabled
}

/**
 * Query mode — controls how the activation pipeline weights its signals.
 *
 * targeted:    Query has identifiers, ticket IDs, specific names. Boost BM25,
 *              narrow graph beam, stronger decay, stricter vector z-gate.
 * exploratory: Vague/conceptual query. Boost vector/semantic signals, wider
 *              graph beam, weaker decay, relaxed z-gate.
 * balanced:    Default weights (current behavior).
 * auto:        Classify automatically based on query characteristics.
 */
export type QueryMode = 'targeted' | 'exploratory' | 'balanced' | 'auto';

export interface ActivationQuery {
  agentId: string;
  context: string;
  limit?: number;
  minScore?: number;
  includeStaging?: boolean;
  includeRetracted?: boolean;
  useReranker?: boolean;       // Enable cross-encoder re-ranking (default: true)
  useExpansion?: boolean;      // Enable query expansion (default: true)
  abstentionThreshold?: number; // Min reranker score to return results (default: 0)
  /**
   * Opt-in confidence-based abstention. When set, the recall returns []
   * if the computed recall confidence (see src/engine/confidence.ts) falls
   * below the threshold. Independent of `abstentionThreshold` (reranker-based);
   * uses score-distribution shape rather than reranker score.
   * Typical values: 0.10 (strict — only abstain on clearly noisy queries),
   * 0.25 (balanced), 0.40 (aggressive — only return high-confidence recall).
   */
  requireConfidence?: number;
  internal?: boolean;          // Skip access count increment, Hebbian update, and event logging (for system calls)
  memoryType?: MemoryType;     // Filter by memory type (episodic, semantic, procedural)
  mode?: QueryMode;            // Pipeline mode — 'auto' by default
  workspace?: string;          // Search across all agents in this workspace (hive mode). If unset, agent-scoped only.
  bm25Only?: boolean;          // Skip embedding — fast text-only retrieval for bulk/benchmark scenarios
  /**
   * Output granularity (Paper 3: cognitive teaming, Brill 2018 ACT-R collaboration).
   * Controls how much engram content the activation engine surfaces back to the caller,
   * trading depth for breadth based on recall quality.
   *
   * 'full' (default): no change — callers get the raw engram with full content.
   * 'compact': every result gets a short `summary` field (first ~200 chars of content).
   *            Engram body is unchanged; callers can choose summary or content.
   * 'auto':   confidence-adaptive. When the recall has a clear winner (confidence
   *           ≥ AWM_GRANULARITY_AUTO_THRESHOLD, default 0.4), the top result keeps a
   *           full-content summary and lower-ranked results get compact ones —
   *           the agent absorbs the strong match in detail and scans alternatives.
   *           When confidence is low, all results get compact summaries so the
   *           agent can scan a diverse set without drowning in content.
   */
  granularity?: 'full' | 'compact' | 'auto';
}

/**
 * Search query — deterministic retrieval for diagnostics and debugging.
 * Separate from activation (which is cognitive/associative).
 */
export interface SearchQuery {
  agentId: string;
  text?: string;          // Exact or partial text match
  concept?: string;       // Exact concept match
  /** Tag filter — AND semantics. Existing field kept for compat; equivalent to `tagsAll`.
   *  If both `tags` and `tagsAll` are passed, results match tags from both arrays
   *  (intersection of both AND-filters). */
  tags?: string[];
  /** AND-filter: engram must have ALL of these tags. Alias for legacy `tags`. (0.8 Cluster B) */
  tagsAll?: string[];
  /** OR-filter: engram must have AT LEAST ONE of these tags. (0.8 Cluster B) */
  tagsAny?: string[];
  /** NOT-filter: engram must have NONE of these tags. (0.8 Cluster B) */
  tagsNone?: string[];
  stage?: EngramStage;
  retracted?: boolean;
  limit?: number;
  offset?: number;
  /** Sort field. Defaults to `lastAccessed` (existing behavior preserved when
   *  unspecified). `sequence` sorts NULL last. (0.8 Cluster B) */
  sortBy?: 'createdAt' | 'sequence' | 'salience' | 'confidence' | 'lastAccessed';
  /** Sort direction. Default `desc`. (0.8 Cluster B) */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Retrieval feedback — agent reports whether a memory was useful.
 * Used to update confidence scores and eval metrics.
 */
export interface RetrievalFeedback {
  engramId: string;
  useful: boolean;
  context: string;        // What the agent was doing when it judged usefulness
}

/**
 * Retraction — marks a memory as invalid/wrong.
 */
export interface Retraction {
  targetEngramId: string;
  reason: string;
  counterContent?: string;  // Optional: what the correct information is
  agentId: string;
}

/**
 * Episode — a temporal grouping of engrams from a session or time window.
 * Enables episode-first retrieval: find relevant episodes, then drill into engrams.
 */
export interface Episode {
  id: string;
  agentId: string;
  label: string;           // Short description (e.g., "Express migration session")
  embedding: number[] | null;  // Centroid of member engram embeddings
  engramCount: number;
  startTime: Date;
  endTime: Date;
  createdAt: Date;
}

export interface EpisodeCreate {
  agentId: string;
  label: string;
  embedding?: number[];
}
