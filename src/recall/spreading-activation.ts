// ============================================
// Engram Spreading Activation & Associative Boost
// ============================================

import type { Memory } from '../core/types.js';
import type { GraphStore } from '../storage/graph-store.js';

export interface ActivationBoost {
  memoryId: string;
  boost: number;            // 0.0 to ~0.3
  sourceEntityName: string;
  activationPath: string;   // e.g. "Peanuts -> [dietary_restrictions] -> Vegetarian"
}

/**
 * Computes spreading activation boosts across the knowledge graph:
 * 1. Collects all entities directly referenced in the direct recall set.
 * 2. Traverses 1-hop category neighbors in the entity graph.
 * 3. Identifies associative memories that pure vector search would otherwise miss.
 * 
 * @param directMemories The set of candidate memories retrieved by vector/salience
 * @param graphStore The entity graph store
 * @returns Map of memoryId -> ActivationBoost
 */
export function computeSpreadingActivation(
  directMemories: Memory[],
  graphStore: GraphStore
): Map<string, ActivationBoost> {
  const boostMap = new Map<string, ActivationBoost>();

  // Track direct memory IDs to avoid double-boosting or loops
  const directIdSet = new Set(directMemories.map(m => m.id));

  for (const memory of directMemories) {
    const linkedEntities = graphStore.getEntitiesForMemory(memory.id);

    for (const entityLink of linkedEntities) {
      // 1. Direct entity association (memories sharing the exact same entity)
      const coMemories = graphStore.getMemoriesForEntity(entityLink.entity_id);
      for (const coId of coMemories) {
        if (!directIdSet.has(coId) && !boostMap.has(coId)) {
          boostMap.set(coId, {
            memoryId: coId,
            boost: 0.25,
            sourceEntityName: entityLink.entity_name,
            activationPath: `Direct entity match: ${entityLink.entity_name}`
          });
        }
      }

      // 2. 1-hop category traversal (spreading activation across conceptual categories)
      const relatedEntities = graphStore.getRelatedEntities(entityLink.entity_id);
      for (const rel of relatedEntities) {
        const catMemories = graphStore.getMemoriesForEntity(rel.entity.id);
        for (const catId of catMemories) {
          if (!directIdSet.has(catId)) {
            const existing = boostMap.get(catId);
            const associativeBoost = 0.15;

            if (!existing || existing.boost < associativeBoost) {
              boostMap.set(catId, {
                memoryId: catId,
                boost: associativeBoost,
                sourceEntityName: rel.entity.name,
                activationPath: `${entityLink.entity_name} -> [${rel.sharedCategory}] -> ${rel.entity.name}`
              });
            }
          }
        }
      }
    }
  }

  return boostMap;
}
