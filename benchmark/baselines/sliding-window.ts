// ============================================
// Baseline 2: Sliding Window Memory System
// ============================================

import type { Memory } from '../../src/core/types.js';
import { cosineSimilarity } from '../../src/storage/vector-store.js';

export class SlidingWindowBaseline {
  private windowSize: number;
  private queue: { memory: Memory; embedding: number[] }[] = [];

  constructor(windowSize = 10) {
    this.windowSize = windowSize;
  }

  public store(memory: Memory, embedding: number[]): void {
    if (this.queue.length >= this.windowSize) {
      this.queue.shift(); // Evict oldest
    }
    this.queue.push({ memory, embedding });
  }

  public recall(queryEmbedding: number[], topK = 5): Memory[] {
    const scored = this.queue.map(item => ({
      memory: item.memory,
      similarity: cosineSimilarity(queryEmbedding, item.embedding)
    }));

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK).map(s => s.memory);
  }

  public getActiveCount(): number {
    return this.queue.length;
  }
}
