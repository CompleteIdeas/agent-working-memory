// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Checkpoint types — conscious state preservation across compaction.
 *
 * ConsciousState: explicit structured snapshot (saved by agent)
 * AutoCheckpoint: implicit lightweight tracking (updated on every write/recall)
 */

export interface ConsciousState {
  currentTask: string;
  decisions: string[];
  activeFiles: string[];
  nextSteps: string[];
  relatedMemoryIds: string[];
  notes: string;
  episodeId: string | null;
}

export interface AutoCheckpoint {
  lastWriteId: string | null;
  lastRecallContext: string | null;
  lastRecallIds: string[];
  lastActivityAt: Date;
  writeCountSinceConsolidation: number;
  recallCountSinceConsolidation: number;
}

export interface CheckpointRow {
  agentId: string;
  auto: AutoCheckpoint;
  executionState: ConsciousState | null;
  checkpointAt: Date | null;
  lastConsolidationAt: Date | null;
  lastMiniConsolidationAt: Date | null;
  updatedAt: Date;
}

export interface RestoreResult {
  executionState: ConsciousState | null;
  checkpointAt: Date | null;
  recalledMemories: Array<{ id: string; concept: string; content: string; score: number }>;
  lastWrite: { id: string; concept: string; content: string } | null;
  idleMs: number;
  miniConsolidationTriggered: boolean;
}
