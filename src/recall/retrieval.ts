// ============================================
// Engram Multi-Signal Retrieval & Re-ranking
// ============================================

import type { Memory, RecallResult } from '../core/types.js';
import type { MemoryStore } from '../storage/memory-store.js';
import type { VectorStore } from '../storage/vector-store.js';
import type { EmbeddingProvider } from '../providers/interface.js';
import { computeSalience, isMemoryDormant } from '../core/salience.js';

export interface RetrievalOptions {
  userId?: string;
  limit?: number;
  minSimilarity?: number;
  pruningThreshold?: number;
  similarityWeight?: number;
  salienceWeight?: number;
}

/**
 * Executes multi-signal recall:
 * 1. Semantic vector search for candidate matching
 * 2. Real-time salience computation (Ebbinghaus decay & spaced repetition)
 * 3. Pruning of dormant memories (salience < threshold)
 * 4. Combined scoring: similarityWeight * similarity + salienceWeight * salience
 * 5. Re-ranking and truncation to top-K
 */
export async function retrieveMemories(
  query: string,
  memoryStore: MemoryStore,
  vectorStore: VectorStore,
  embedder: EmbeddingProvider | null,
  now: Date,
  options: RetrievalOptions = {}
): Promise<RecallResult[]> {
  const userId = options.userId || 'default_user';
  const limit = options.limit || 5;
  const minSimilarity = options.minSimilarity ?? 0.2;
  const pruningThreshold = options.pruningThreshold ?? 0.01;
  const simWeight = options.similarityWeight ?? 0.5;
  const salWeight = options.salienceWeight ?? 0.5;

  const candidatePairs: { memory: Memory; similarity: number }[] = [];

  if (embedder) {
    try {
      const queryVec = await embedder.embed(query);
      // Retrieve a generous candidate set for salience re-ranking
      const rawResults = vectorStore.search(queryVec, limit * 4, minSimilarity);

      for (const res of rawResults) {
        const mem = memoryStore.getById(res.memory_id);
        if (mem && mem.status === 'active' && mem.user_id === userId) {
          candidatePairs.push({ memory: mem, similarity: res.similarity });
        }
      }
    } catch {
      // Embedding failure fallback
    }
  }

  // Fallback if no embedder or no candidates found via vectors
  if (candidatePairs.length === 0) {
    const active = memoryStore.getActiveByUser(userId);
    const queryLower = query.toLowerCase();

    for (const mem of active) {
      const contentLower = mem.content.toLowerCase();
      // Simple word overlap scoring for keyword fallback
      const words = queryLower.split(/\s+/).filter(w => w.length > 2);
      const matchedWords = words.filter(w => contentLower.includes(w));
      const similarity = words.length > 0 ? matchedWords.length / words.length : 0.5;

      if (similarity > 0.0 || words.length === 0) {
        candidatePairs.push({ memory: mem, similarity: Math.max(0.3, similarity) });
      }
    }
  }

  const results: RecallResult[] = [];

  for (const { memory, similarity } of candidatePairs) {
    const salience = computeSalience(memory, now);

    // Filter out dormant memories — they do not surface in active recall
    if (isMemoryDormant(salience, pruningThreshold)) {
      continue;
    }

    // Hybrid re-ranking: combines semantic closeness with memory durability
    const finalScore = (simWeight * similarity) + (salWeight * salience);

    results.push({
      memory,
      similarity_score: similarity,
      salience_score: salience,
      association_boost: 0,
      final_score: finalScore
    });
  }

  // Sort descending by combined final_score
  results.sort((a, b) => b.final_score - a.final_score);

  return results.slice(0, limit);
}
