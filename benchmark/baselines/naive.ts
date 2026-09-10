// ============================================
// Baseline 1: Naive RAG Memory System
// ============================================

import type { Memory } from '../../src/core/types.js';
import { cosineSimilarity } from '../../src/storage/vector-store.js';

export class NaiveMemoryBaseline {
  private memories: { memory: Memory; embedding: number[] }[] = [];

  public store(memory: Memory, embedding: number[]): void {
    this.memories.push({ memory, embedding });
  }

  public recall(queryEmbedding: number[], topK = 5): Memory[] {
    const scored = this.memories.map(item => ({
      memory: item.memory,
      similarity: cosineSimilarity(queryEmbedding, item.embedding)
    }));

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK).map(s => s.memory);
  }

  public getActiveCount(): number {
    return this.memories.length;
  }
}
