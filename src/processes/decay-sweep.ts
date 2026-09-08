// ============================================
// Engram Background Decay Sweep & Pruning
// ============================================

import type { EngineConfig } from '../core/types.js';
import { DEFAULT_CONFIG } from '../core/types.js';
import type { MemoryStore } from '../storage/memory-store.js';
import type { VectorStore } from '../storage/vector-store.js';
import { computeSalience, diffHours, isMemoryDormant } from '../core/salience.js';

export interface DecaySweepReport {
  timestamp: string;
  checkedCount: number;
  markedDormantCount: number;
  purgedCount: number;
  activeRemainingCount: number;
  dormantRemainingCount: number;
}

/**
 * Executes a background maintenance sweep:
 * 1. Checks all active memories and computes current salience
 * 2. Moves memories with salience < pruning_threshold into 'dormant' status
 * 3. Permanently purges dormant memories that have exceeded the retention grace period
 * 
 * @param memoryStore The SQLite memory store
 * @param vectorStore The vector embedding store
 * @param now Current timestamp (enables deterministic time simulation)
 * @param config Engine configuration
 * @param gracePeriodHours Hours a dormant memory is kept before permanent purging (default 168h = 7 days)
 */
export function runDecaySweep(
  memoryStore: MemoryStore,
  vectorStore: VectorStore,
  now: Date,
  config: EngineConfig = DEFAULT_CONFIG,
  gracePeriodHours = 168
): DecaySweepReport {
  const activeMemories = memoryStore.getByStatus('active');
  let markedDormantCount = 0;
  let purgedCount = 0;

  // 1. Check active memories for dormancy
  for (const memory of activeMemories) {
    const salience = computeSalience(memory, now);
    if (isMemoryDormant(salience, config.pruning_threshold)) {
      memoryStore.updateStatus(memory.id, 'dormant');
      markedDormantCount++;
    }
  }

  // 2. Check dormant memories for permanent purging
  const dormantMemories = memoryStore.getByStatus('dormant');
  for (const memory of dormantMemories) {
    const lastDate = new Date(memory.last_recalled_at || memory.created_at);
    const hoursElapsed = diffHours(now, lastDate);

    if (hoursElapsed >= gracePeriodHours) {
      memoryStore.deleteMemory(memory.id);
      vectorStore.delete(memory.id);
      purgedCount++;
    }
  }

  const remainingActive = memoryStore.getByStatus('active').length;
  const remainingDormant = memoryStore.getByStatus('dormant').length;

  return {
    timestamp: now.toISOString(),
    checkedCount: activeMemories.length,
    markedDormantCount,
    purgedCount,
    activeRemainingCount: remainingActive,
    dormantRemainingCount: remainingDormant
  };
}
