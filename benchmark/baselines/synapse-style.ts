// ============================================
// Baseline 3: Synapse-Style Memory System
// ============================================

import type { Memory } from '../../src/core/types.js';
import { cosineSimilarity } from '../../src/storage/vector-store.js';

export class SynapseStyleBaseline {
  private memories: { memory: Memory; embedding: number[] }[] = [];
  private fixedHalfLifeHours: number;

  constructor(fixedHalfLifeHours = 72) {
    this.fixedHalfLifeHours = fixedHalfLifeHours;
  }

  public store(memory: Memory, embedding: number[]): void {
    // Naive cosine contradiction: if similarity > 0.75, replace old memory
    const existingIdx = this.memories.findIndex(m => cosineSimilarity(embedding, m.embedding) > 0.75);
    if (existingIdx >= 0) {
      this.memories[existingIdx] = { memory, embedding };
    } else {
      this.memories.push({ memory, embedding });
    }
  }

  public recall(queryEmbedding: number[], now: Date, topK = 5): Memory[] {
    const scored = this.memories.map(item => {
      const sim = cosineSimilarity(queryEmbedding, item.embedding);
      const lastRecall = new Date(item.memory.last_recalled_at || item.memory.created_at);
      const hoursElapsed = Math.max(0, (now.getTime() - lastRecall.getTime()) / (1000 * 60 * 60));
      // Fixed exponential decay (no spaced repetition adaptive scaling)
      const decay = Math.exp((-Math.LN2 / this.fixedHalfLifeHours) * hoursElapsed);
      const salience = item.memory.importance * decay;

      return {
        memory: item.memory,
        finalScore: (0.5 * sim) + (0.5 * salience)
      };
    });

    scored.sort((a, b) => b.finalScore - a.finalScore);
    return scored.slice(0, topK).map(s => s.memory);
  }

  public getActiveCount(): number {
    return this.memories.length;
  }
}
