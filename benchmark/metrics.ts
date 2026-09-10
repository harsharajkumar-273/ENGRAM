// ============================================
// Engram Benchmark Metrics Engine
// ============================================

import type { Memory } from '../src/core/types.js';

export interface BenchmarkMetrics {
  recallAtK: number;            // 0.0 to 1.0: Fraction of expected ground-truth facts retrieved
  precisionAtK: number;         // 0.0 to 1.0: Fraction of retrieved memories that are relevant
  stalenessResistance: number;  // 0.0 to 1.0: Fraction of retrieved memories that are NOT outdated (higher is better)
  totalTokenCost: number;       // Approximate tokens consumed by retrieved context
  activeMemoryCount: number;    // Database footprint
}

/**
 * Computes Recall@K: fraction of required ground-truth keywords present in retrieved memories.
 */
export function computeRecallAtK(retrieved: Memory[], expectedKeywords: string[], k = 5): number {
  if (expectedKeywords.length === 0) return 1.0;
  const topK = retrieved.slice(0, k);
  const text = topK.map(m => m.content.toLowerCase()).join(' ');

  let matches = 0;
  for (const kw of expectedKeywords) {
    if (text.includes(kw.toLowerCase())) matches++;
  }

  return matches / expectedKeywords.length;
}

/**
 * Computes Precision@K: fraction of retrieved memories that match any expected keyword.
 */
export function computePrecisionAtK(retrieved: Memory[], expectedKeywords: string[], k = 5): number {
  const topK = retrieved.slice(0, k);
  if (topK.length === 0) return 0.0;

  let relevantCount = 0;
  for (const mem of topK) {
    const memLower = mem.content.toLowerCase();
    const isRelevant = expectedKeywords.some(kw => memLower.includes(kw.toLowerCase()));
    if (isRelevant) relevantCount++;
  }

  return relevantCount / topK.length;
}

/**
 * Computes Staleness Resistance: fraction of retrieved memories that DO NOT contain outdated facts.
 * 1.0 = perfect (0% stale facts leaked into context).
 * 0.0 = terrible (all retrieved memories are stale/superseded).
 */
export function computeStalenessResistance(retrieved: Memory[], outdatedKeywords: string[], k = 5): number {
  const topK = retrieved.slice(0, k);
  if (topK.length === 0 || outdatedKeywords.length === 0) return 1.0;

  let staleCount = 0;
  for (const mem of topK) {
    const memLower = mem.content.toLowerCase();
    const isStale = outdatedKeywords.some(kw => memLower.includes(kw.toLowerCase()));
    if (isStale) staleCount++;
  }

  return 1.0 - (staleCount / topK.length);
}

/**
 * Estimates token count for memory context injection (~4 characters per token).
 */
export function computeTokenCost(memories: Memory[]): number {
  const text = memories.map(m => m.content).join(' ');
  return Math.ceil(text.length / 4);
}
