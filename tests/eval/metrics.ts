/**
 * Eval Metrics — pure functions for benchmark scoring.
 *
 * Recall@k, MRR, nDCG@k, Spearman rank correlation, dedup F1.
 */

/** Recall@k — fraction of ground-truth items found in the top-k results. */
export function recallAtK(retrieved: string[], groundTruth: string[], k: number): number {
  if (groundTruth.length === 0) return 1; // vacuously true
  const topK = new Set(retrieved.slice(0, k));
  const hits = groundTruth.filter(id => topK.has(id)).length;
  return hits / groundTruth.length;
}

/** Mean Reciprocal Rank — 1/rank of the first relevant result (0 if none found). */
export function mrr(retrieved: string[], groundTruth: string[]): number {
  const relevant = new Set(groundTruth);
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

/** Normalized Discounted Cumulative Gain @ k. */
export function ndcgAtK(retrieved: string[], groundTruth: string[], k: number): number {
  const relevant = new Set(groundTruth);
  const topK = retrieved.slice(0, k);

  // DCG: sum of 1/log2(i+2) for relevant items at position i
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    if (relevant.has(topK[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }

  // Ideal DCG: all relevant items ranked first
  const idealK = Math.min(groundTruth.length, k);
  let idcg = 0;
  for (let i = 0; i < idealK; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Spearman rank correlation between two score arrays.
 * Both arrays must be the same length. Returns [-1, 1].
 */
export function spearmanCorrelation(actual: number[], expected: number[]): number {
  if (actual.length !== expected.length || actual.length < 2) return 0;
  const n = actual.length;

  const rankArray = (arr: number[]): number[] => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const ranks = new Array(n);
    for (let i = 0; i < n; i++) ranks[sorted[i].i] = i + 1;
    return ranks;
  };

  const ranksA = rankArray(actual);
  const ranksE = rankArray(expected);

  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = ranksA[i] - ranksE[i];
    sumD2 += d * d;
  }

  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

/**
 * Dedup F1 — measures how well consolidation identifies paraphrase clusters.
 *
 * @param clusters - Map of canonical ID -> array of paraphrase IDs that SHOULD be merged
 * @param survivingIds - Set of engram IDs that still exist after consolidation
 * @returns { precision, recall, f1 }
 */
export function dedupF1(
  clusters: Map<string, string[]>,
  survivingIds: Set<string>,
): { precision: number; recall: number; f1: number } {
  let truePositives = 0;  // Correctly merged (paraphrase gone, canonical or one representative survives)
  let falseNegatives = 0; // Paraphrase survived when it shouldn't have
  let falsePositives = 0; // Non-paraphrase was removed

  for (const [canonicalId, paraphraseIds] of clusters) {
    const allInCluster = [canonicalId, ...paraphraseIds];
    const surviving = allInCluster.filter(id => survivingIds.has(id));

    if (surviving.length === 0) {
      // Everything deleted — bad. Count as FP for over-merging.
      falsePositives += 1;
    } else {
      // At least one survived (good). Each additional removed = TP, each extra surviving = FN.
      const merged = allInCluster.length - surviving.length;
      const expectedMerges = allInCluster.length - 1; // Ideally keep exactly 1
      truePositives += Math.min(merged, expectedMerges);
      falseNegatives += Math.max(0, surviving.length - 1);
    }
  }

  const precision = truePositives + falsePositives === 0
    ? 1 : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0
    ? 1 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0
    ? 0 : 2 * precision * recall / (precision + recall);

  return { precision, recall, f1 };
}

/** Average a metric across multiple queries. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Report structure for a single eval suite. */
export interface SuiteResult {
  name: string;
  pass: boolean;
  threshold: number;
  score: number;
  details: Record<string, number>;
}

/** Full eval report. */
export interface EvalReport {
  timestamp: string;
  suites: SuiteResult[];
  ablation?: Record<string, SuiteResult[]>;
  summary: { passed: number; failed: number; total: number };
}
