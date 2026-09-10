// ============================================
// Engram Multi-Signal Retrieval & Re-ranking
// ============================================

import type { Memory, RecallResult } from '../core/types.js';
import type { MemoryStore } from '../storage/memory-store.js';
import type { VectorStore } from '../storage/vector-store.js';
import type { GraphStore } from '../storage/graph-store.js';
import type { EmbeddingProvider } from '../providers/interface.js';
import { computeSalience, isMemoryDormant } from '../core/salience.js';
import { computeSpreadingActivation } from './spreading-activation.js';

export interface RetrievalOptions {
  userId?: string;
  limit?: number;
  minSimilarity?: number;
  pruningThreshold?: number;
  similarityWeight?: number;
  salienceWeight?: number;
  graphStore?: GraphStore | null;
}

/**
 * Executes multi-signal recall:
 * 1. Semantic vector search for candidate matching
 * 2. Spreading activation across entity graph (associative recall)
 * 3. Real-time salience computation (Ebbinghaus decay & spaced repetition)
 * 4. Pruning of dormant memories (salience < threshold)
 * 5. Combined scoring: (simWeight * sim) + (salWeight * salience) + association_boost
 * 6. Re-ranking and truncation to top-K
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
  const graphStore = options.graphStore || null;

  const simWeight = options.similarityWeight ?? (graphStore ? 0.4 : 0.5);
  const salWeight = options.salienceWeight ?? (graphStore ? 0.4 : 0.5);

  const candidatePairs: { memory: Memory; similarity: number; associationBoost: number }[] = [];
  const candidateIdSet = new Set<string>();

  if (embedder) {
    try {
      const queryVec = await embedder.embed(query);
      // Retrieve a generous candidate set for salience and graph re-ranking
      const rawResults = vectorStore.search(queryVec, limit * 4, minSimilarity);

      for (const res of rawResults) {
        const mem = memoryStore.getById(res.memory_id);
        if (mem && mem.status === 'active' && mem.user_id === userId) {
          candidatePairs.push({ memory: mem, similarity: res.similarity, associationBoost: 0 });
          candidateIdSet.add(mem.id);
        }
      }
    } catch {
      // Fallback
    }
  }

  // Fallback if no embedder or no candidates found via vectors
  if (candidatePairs.length === 0) {
    const active = memoryStore.getActiveByUser(userId);
    const queryLower = query.toLowerCase();

    for (const mem of active) {
      const contentLower = mem.content.toLowerCase();
      const words = queryLower.split(/\s+/).filter(w => w.length > 2);
      const matchedWords = words.filter(w => contentLower.includes(w));
      const similarity = words.length > 0 ? matchedWords.length / words.length : 0.5;

      if (similarity > 0.0 || words.length === 0) {
        candidatePairs.push({ 
          memory: mem, 
          similarity: Math.max(0.3, similarity), 
          associationBoost: 0 
        });
        candidateIdSet.add(mem.id);
      }
    }
  }

  // Spreading activation across entity graph
  if (graphStore && candidatePairs.length > 0) {
    const directMemories = candidatePairs.map(p => p.memory);
    const activationMap = computeSpreadingActivation(directMemories, graphStore);

    for (const [memId, activation] of activationMap.entries()) {
      if (!candidateIdSet.has(memId)) {
        const assocMem = memoryStore.getById(memId);
        if (assocMem && assocMem.status === 'active' && assocMem.user_id === userId) {
          candidatePairs.push({
            memory: assocMem,
            similarity: 0.35, // Baseline conceptual similarity for graph-discovered items
            associationBoost: activation.boost
          });
          candidateIdSet.add(memId);
        }
      } else {
        // Boost existing candidate
        const existing = candidatePairs.find(p => p.memory.id === memId);
        if (existing) {
          existing.associationBoost = Math.max(existing.associationBoost, activation.boost);
        }
      }
    }
  }

  const results: RecallResult[] = [];

  for (const { memory, similarity, associationBoost } of candidatePairs) {
    const salience = computeSalience(memory, now);

    // Filter out dormant memories
    if (isMemoryDormant(salience, pruningThreshold)) {
      continue;
    }

    // Combined multi-signal scoring
    const finalScore = (simWeight * similarity) + (salWeight * salience) + associationBoost;

    results.push({
      memory,
      similarity_score: similarity,
      salience_score: salience,
      association_boost: associationBoost,
      final_score: finalScore
    });
  }

  // Sort descending by combined final_score
  results.sort((a, b) => b.final_score - a.final_score);

  return results.slice(0, limit);
}
