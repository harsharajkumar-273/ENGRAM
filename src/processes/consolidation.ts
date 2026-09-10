// ============================================
// Engram Memory Consolidation (The Sleep Pass)
// ============================================

import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Memory, Message } from '../core/types.js';
import type { LLMProvider, EmbeddingProvider } from '../providers/interface.js';
import type { MemoryStore } from '../storage/memory-store.js';
import type { VectorStore } from '../storage/vector-store.js';
import type { GraphStore } from '../storage/graph-store.js';
import { cosineSimilarity } from '../storage/vector-store.js';

export interface ConsolidationSummary {
  summary: string;
  importance: number;
  emotional_weight: number;
  entities: { name: string; type: string; relation: string }[];
}

const CONSOLIDATION_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Cohesive, rich third-person narrative synthesizing the repeated episodic events into one enduring semantic memory' },
    importance: { type: 'number', description: '0.0 to 1.0 importance of the synthesized memory' },
    emotional_weight: { type: 'number', description: '0.0 to 1.0 overall emotional intensity' },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          relation: { type: 'string' }
        },
        required: ['name', 'type', 'relation']
      }
    }
  },
  required: ['summary', 'importance', 'emotional_weight', 'entities']
};

const CONSOLIDATION_PROMPT = `You are the Memory Consolidation Engine of Engram, simulating the mammalian brain's hippocampal-to-neocortical sleep pass.
Your task is to take multiple related episodic memory fragments and synthesize them into a single, comprehensive semantic memory summary.

INSTRUCTIONS:
1. Capture the narrative arc: beginning, progression, obstacles, and current state.
2. Preserve key entities, facts, and emotional trajectory.
3. Eliminate repetitive daily play-by-play while retaining the enduring meaning.
4. Output concise, factual third-person prose.`;

export class ConsolidationEngine {
  private db: Database.Database;
  private memoryStore: MemoryStore;
  private vectorStore: VectorStore;
  private graphStore: GraphStore | null;
  private llm: LLMProvider;
  private embedder: EmbeddingProvider | null;

  constructor(
    db: Database.Database,
    memoryStore: MemoryStore,
    vectorStore: VectorStore,
    llm: LLMProvider,
    embedder: EmbeddingProvider | null,
    graphStore: GraphStore | null = null
  ) {
    this.db = db;
    this.memoryStore = memoryStore;
    this.vectorStore = vectorStore;
    this.llm = llm;
    this.embedder = embedder;
    this.graphStore = graphStore;
  }

  /**
   * Identifies clusters of 3+ related episodic memories suitable for consolidation.
   */
  public findClusters(userId = 'default_user', minSimilarity = 0.65, minClusterSize = 3): Memory[][] {
    const activeEpisodic = this.memoryStore
      .getActiveByUser(userId)
      .filter(m => m.type === 'episodic');

    if (activeEpisodic.length < minClusterSize) return [];

    // Cache embeddings
    const embeddings = new Map<string, number[]>();
    for (const mem of activeEpisodic) {
      const emb = this.vectorStore.getEmbedding(mem.id);
      if (emb) embeddings.set(mem.id, emb);
    }

    // Build adjacency graph of similar memories
    const adj = new Map<string, Set<string>>();
    for (const m of activeEpisodic) adj.set(m.id, new Set());

    for (let i = 0; i < activeEpisodic.length; i++) {
      for (let j = i + 1; j < activeEpisodic.length; j++) {
        const idA = activeEpisodic[i].id;
        const idB = activeEpisodic[j].id;
        const embA = embeddings.get(idA);
        const embB = embeddings.get(idB);

        if (embA && embB) {
          const sim = cosineSimilarity(embA, embB);
          if (sim >= minSimilarity) {
            adj.get(idA)?.add(idB);
            adj.get(idB)?.add(idA);
          }
        }
      }
    }

    // Connected components traversal (BFS)
    const visited = new Set<string>();
    const clusters: Memory[][] = [];

    for (const mem of activeEpisodic) {
      if (visited.has(mem.id)) continue;

      const clusterIds: string[] = [];
      const queue = [mem.id];
      visited.add(mem.id);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        clusterIds.push(curr);

        const neighbors = adj.get(curr) || new Set();
        for (const n of neighbors) {
          if (!visited.has(n)) {
            visited.add(n);
            queue.push(n);
          }
        }
      }

      if (clusterIds.length >= minClusterSize) {
        const clusterMemories = clusterIds
          .map(id => this.memoryStore.getById(id))
          .filter((m): m is Memory => m !== null)
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

        clusters.push(clusterMemories);
      }
    }

    return clusters;
  }

  /**
   * Consolidates a cluster of episodic memories into a single rich semantic memory.
   */
  public async consolidateCluster(cluster: Memory[], nowIso: string): Promise<Memory | null> {
    if (cluster.length === 0) return null;

    const sourceFragments = cluster.map((m, idx) => 
      `${idx + 1}. [${m.created_at}] "${m.content}"`
    ).join('\n');

    const messages: Message[] = [
      { role: 'system', content: CONSOLIDATION_PROMPT },
      {
        role: 'user',
        content: `Please consolidate these related episodic memories into one unified semantic memory:\n\n${sourceFragments}`
      }
    ];

    try {
      const result = await this.llm.chatJSON<ConsolidationSummary>(messages, CONSOLIDATION_SCHEMA, {
        temperature: 0.2
      });

      if (!result || !result.summary) return null;

      const newId = uuidv4();
      const sourceIds = cluster.map(m => m.id);

      // New importance is at least the max of individual fragments
      const maxSourceImp = Math.max(...cluster.map(m => m.importance));
      const finalImportance = Math.max(maxSourceImp, result.importance || 0.7);

      // New emotional weight is max of fragments
      const maxSourceEmo = Math.max(...cluster.map(m => m.emotional_weight));
      const finalEmo = Math.max(maxSourceEmo, result.emotional_weight || 0.1);

      const consolidatedMemory: Memory = {
        id: newId,
        type: 'semantic', // Promoted from episodic to semantic!
        status: 'active',
        content: result.summary,
        source_turn_id: 'consolidation_pass',
        importance: finalImportance,
        emotional_weight: finalEmo,
        recall_count: cluster.reduce((sum, m) => sum + m.recall_count, 0), // Aggregate recalls
        base_half_life_hours: 720, // Semantic base half-life (30 days)
        strengthening_factor: 0.5,
        created_at: nowIso,
        last_recalled_at: nowIso,
        entities: [],
        superseded_by: null,
        consolidated_from: sourceIds,
        user_id: cluster[0].user_id,
        session_id: cluster[0].session_id
      };

      const insertConsolidationStmt = this.db.prepare(`
        INSERT INTO consolidations (id, source_ids, result_id, created_at)
        VALUES (?, ?, ?, ?)
      `);

      const transaction = this.db.transaction(() => {
        // 1. Create the new semantic memory
        this.memoryStore.create(consolidatedMemory);

        // 2. Mark source episodic memories as consolidated
        for (const source of cluster) {
          this.memoryStore.updateStatus(source.id, 'consolidated');
        }

        // 3. Record consolidation history
        insertConsolidationStmt.run(
          uuidv4(),
          JSON.stringify(sourceIds),
          newId,
          nowIso
        );
      });

      transaction();

      // Store vector embedding for the new consolidated memory
      if (this.embedder) {
        try {
          const emb = await this.embedder.embed(consolidatedMemory.content);
          this.vectorStore.store(newId, emb);
        } catch {}
      }

      return consolidatedMemory;
    } catch (err) {
      console.warn('[Engram Consolidation] Failed to consolidate cluster:', err);
      return null;
    }
  }

  /**
   * Runs an end-to-end consolidation pass across all qualifying clusters.
   */
  public async runConsolidationPass(userId = 'default_user', nowIso: string): Promise<Memory[]> {
    const clusters = this.findClusters(userId);
    const consolidatedMemories: Memory[] = [];

    for (const cluster of clusters) {
      const result = await this.consolidateCluster(cluster, nowIso);
      if (result) consolidatedMemories.push(result);
    }

    return consolidatedMemories;
  }
}
