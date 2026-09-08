// ============================================
// Engram Salience & Ebbinghaus Decay Engine
// ============================================

import type { Memory } from './types.js';
import { clampEmotionalWeight, getEmotionalDecayMultiplier } from './emotional.js';

/**
 * Computes the adaptive half-life for a memory.
 * Each time a memory is recalled, its half-life grows by (1 + strengthening_factor)^n.
 * 
 * H(n) = H_0 * (1 + alpha)^n
 * 
 * @param memory The memory record
 * @returns Adaptive half-life in hours
 */
export function getAdaptiveHalfLife(memory: Memory): number {
  const baseHalfLife = Math.max(1, memory.base_half_life_hours);
  const alpha = Math.max(0, memory.strengthening_factor ?? 0.5);
  const n = Math.max(0, memory.recall_count);

  return baseHalfLife * Math.pow(1 + alpha, n);
}

/**
 * Computes the elapsed time in hours between two dates.
 */
export function diffHours(target: Date, reference: Date): number {
  const diffMs = target.getTime() - reference.getTime();
  return Math.max(0, diffMs / (1000 * 60 * 60));
}

/**
 * Computes the salience S(t) of a memory at a specific point in time:
 * 
 * S(t) = Importance * recall_boost(n) * decay(dt, n) * emotional_multiplier(E)
 * 
 * where:
 *   recall_boost(n) = 1 + ln(1 + n)
 *   decay(dt, n) = exp(-ln(2) / H(n) * dt)
 *   emotional_multiplier(E) = 1 + E
 * 
 * @param memory The memory record
 * @param now Current timestamp (allows deterministic simulation and testing)
 * @returns The computed salience score (typically 0.0 to ~3.0+)
 */
export function computeSalience(memory: Memory, now: Date): number {
  const lastRecallDate = new Date(memory.last_recalled_at || memory.created_at);
  const hoursSinceLastRecall = diffHours(now, lastRecallDate);
  const adaptiveHalfLife = getAdaptiveHalfLife(memory);

  // Exponential decay factor based on adaptive half-life
  const decayFactor = Math.exp((-Math.LN2 / adaptiveHalfLife) * hoursSinceLastRecall);

  // Logarithmic recall boost from repetition
  const recallBoost = 1 + Math.log(1 + Math.max(0, memory.recall_count));

  // Emotional retention multiplier (1.0 to 2.0)
  const emotionalMultiplier = getEmotionalDecayMultiplier(memory.emotional_weight);

  const importance = Math.max(0.01, Math.min(1.0, memory.importance));

  const salience = importance * recallBoost * decayFactor * emotionalMultiplier;

  return Math.max(0, salience);
}

/**
 * Determines whether a memory is dormant (faded past the retention threshold).
 * 
 * @param salience The computed salience score
 * @param threshold Pruning threshold (default 0.01)
 */
export function isMemoryDormant(salience: number, threshold = 0.01): boolean {
  return salience < threshold;
}

/**
 * Calculates how many hours from the reference timestamp until a memory's salience
 * decays below the dormancy threshold.
 * 
 * @param memory The memory record
 * @param now Current timestamp
 * @param threshold Dormancy threshold (default 0.01)
 * @returns Hours remaining until dormancy (0 if already dormant)
 */
export function hoursUntilDormant(memory: Memory, now: Date, threshold = 0.01): number {
  const currentSalience = computeSalience(memory, now);
  if (currentSalience < threshold) return 0;

  const adaptiveHalfLife = getAdaptiveHalfLife(memory);
  const recallBoost = 1 + Math.log(1 + Math.max(0, memory.recall_count));
  const emotionalMultiplier = getEmotionalDecayMultiplier(memory.emotional_weight);
  const importance = Math.max(0.01, Math.min(1.0, memory.importance));

  // Initial peak salience right at the moment of last recall (dt = 0)
  const peakSalience = importance * recallBoost * emotionalMultiplier;
  if (peakSalience <= threshold) return 0;

  // Total hours from last recall to dormancy: dt_total = (H(n) / ln(2)) * ln(peak / threshold)
  const totalHoursToDormancy = (adaptiveHalfLife / Math.LN2) * Math.log(peakSalience / threshold);

  const lastRecallDate = new Date(memory.last_recalled_at || memory.created_at);
  const hoursElapsed = diffHours(now, lastRecallDate);

  return Math.max(0, totalHoursToDormancy - hoursElapsed);
}
