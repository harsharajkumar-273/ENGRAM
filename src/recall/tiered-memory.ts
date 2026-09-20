import type Database from 'better-sqlite3';
import type { Memory, MemoryTier, MemoryTierState, RecallResult } from '../core/types.js';
import type { EmbeddingProvider } from '../providers/interface.js';
import type { GraphStore } from '../storage/graph-store.js';
import type { MemoryStore } from '../storage/memory-store.js';
import type { VectorStore } from '../storage/vector-store.js';
import { retrieveMemories, type RetrievalOptions } from './retrieval.js';

export interface TieredRetrievalTrace {
  searchedTiers: MemoryTier[];
  candidateCounts: Partial<Record<MemoryTier, number>>;
  escalated: boolean;
}

export interface TieredRetrievalResult {
  results: RecallResult[];
  trace: TieredRetrievalTrace;
}

export interface TieredRetrievalOptions extends RetrievalOptions {
  confidenceThreshold?: number;
  confidenceSimilarityThreshold?: number;
  minimumResults?: number;
}

/**
 * Maintains lightweight retrieval metadata separately from canonical memories.
 * A memory has exactly one authoritative record; tiers only control how eagerly
 * its compact cue is searched.
 */
export class MemoryTierManager {
  constructor(
    private readonly db: Database.Database,
    private readonly vectorStore?: VectorStore
  ) {}

  public ensure(memory: Memory): MemoryTierState {
    const existing = this.get(memory.id);
    if (existing) {
      this.vectorStore?.setTier(memory.id, existing.tier);
      return existing;
    }

    const pinned = this.isSafetyCritical(memory);
    const tier: MemoryTier = pinned || memory.importance >= 0.9
      ? 'hot'
      : memory.importance >= 0.55 || memory.type === 'procedural'
        ? 'warm'
        : 'cold';
    const utility = this.computeUtility(memory, 0, 0, null, pinned, new Date(memory.created_at));
    const cue = this.createCue(memory);

    this.db.prepare(`
      INSERT INTO memory_tiers
        (memory_id, tier, cue, utility_score, pinned)
      VALUES (?, ?, ?, ?, ?)
    `).run(memory.id, tier, cue, utility, pinned ? 1 : 0);
    this.vectorStore?.setTier(memory.id, tier);

    return this.get(memory.id)!;
  }

  public get(memoryId: string): MemoryTierState | null {
    const row = this.db.prepare('SELECT * FROM memory_tiers WHERE memory_id = ?')
      .get(memoryId) as any;
    return row ? this.rowToState(row) : null;
  }

  public idsForUser(userId: string, tiers: MemoryTier[]): Set<string> {
    if (tiers.length === 0) return new Set();
    const placeholders = tiers.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT mt.memory_id
      FROM memory_tiers mt
      JOIN memories m ON m.id = mt.memory_id
      WHERE m.user_id = ? AND m.status = 'active' AND mt.tier IN (${placeholders})
    `).all(userId, ...tiers) as { memory_id: string }[];
    return new Set(rows.map(row => row.memory_id));
  }

  public ensureUser(userId: string): void {
    const rows = this.db.prepare(`
      SELECT m.id
      FROM memories m
      LEFT JOIN memory_tiers mt ON mt.memory_id = m.id
      WHERE m.user_id = ? AND m.status = 'active' AND mt.memory_id IS NULL
    `).all(userId) as { id: string }[];
    // Hydration is deliberately lazy so old databases gain tier metadata safely.
    for (const row of rows) {
      const canonical = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(row.id) as any;
      const entityRows = this.db.prepare(`
        SELECT me.entity_id, e.name AS entity_name, e.type AS entity_type, me.relation
        FROM memory_entities me LEFT JOIN entities e ON e.id = me.entity_id
        WHERE me.memory_id = ?
      `).all(row.id) as any[];
      this.ensure({
        id: canonical.id,
        type: canonical.type,
        status: canonical.status,
        content: canonical.content,
        source_turn_id: canonical.source_turn_id,
        importance: canonical.importance,
        emotional_weight: canonical.emotional_weight,
        recall_count: canonical.recall_count,
        base_half_life_hours: canonical.base_half_life,
        strengthening_factor: canonical.strength_factor,
        created_at: canonical.created_at,
        last_recalled_at: canonical.last_recalled_at,
        superseded_by: canonical.superseded_by,
        consolidated_from: canonical.consolidated_from ? JSON.parse(canonical.consolidated_from) : [],
        user_id: canonical.user_id,
        session_id: canonical.session_id,
        entities: entityRows,
      });
    }
  }

  public recordAccess(memory: Memory, now: Date, successfulUse = false): MemoryTierState {
    const current = this.ensure(memory);
    const accessCount = current.access_count + 1;
    const successCount = current.successful_use_count + (successfulUse ? 1 : 0);
    const utility = this.computeUtility(
      memory, accessCount, successCount, now.toISOString(), current.pinned, now
    );
    const tier = this.selectTier(current.tier, utility, current.pinned);

    this.db.prepare(`
      UPDATE memory_tiers
      SET tier = ?, access_count = ?, successful_use_count = ?,
          last_accessed_at = ?, utility_score = ?
      WHERE memory_id = ?
    `).run(tier, accessCount, successCount, now.toISOString(), utility, memory.id);
    this.vectorStore?.setTier(memory.id, tier);
    return this.get(memory.id)!;
  }

  /** Applies downstream task feedback without counting the same retrieval twice. */
  public recordOutcome(memory: Memory, now: Date, successful: boolean): MemoryTierState {
    const current = this.ensure(memory);
    const successCount = current.successful_use_count + (successful ? 1 : 0);
    const utility = this.computeUtility(
      memory,
      current.access_count,
      successCount,
      current.last_accessed_at,
      current.pinned,
      now
    );
    const tier = this.selectTier(current.tier, utility, current.pinned);
    this.db.prepare(`
      UPDATE memory_tiers
      SET tier = ?, successful_use_count = ?, utility_score = ?
      WHERE memory_id = ?
    `).run(tier, successCount, utility, memory.id);
    this.vectorStore?.setTier(memory.id, tier);
    return this.get(memory.id)!;
  }

  public rebalance(memoryStore: MemoryStore, userId: string, now: Date): MemoryTierState[] {
    this.ensureUser(userId);
    const updated: MemoryTierState[] = [];
    for (const memory of memoryStore.getActiveByUser(userId)) {
      const current = this.ensure(memory);
      const utility = this.computeUtility(
        memory,
        current.access_count,
        current.successful_use_count,
        current.last_accessed_at,
        current.pinned,
        now
      );
      const tier = this.selectTier(current.tier, utility, current.pinned);
      this.db.prepare(
        'UPDATE memory_tiers SET tier = ?, utility_score = ? WHERE memory_id = ?'
      ).run(tier, utility, memory.id);
      this.vectorStore?.setTier(memory.id, tier);
      updated.push(this.get(memory.id)!);
    }
    return updated;
  }

  public stats(userId: string): Record<MemoryTier, number> {
    this.ensureUser(userId);
    const result: Record<MemoryTier, number> = { hot: 0, warm: 0, cold: 0 };
    const rows = this.db.prepare(`
      SELECT mt.tier, COUNT(*) AS count
      FROM memory_tiers mt JOIN memories m ON m.id = mt.memory_id
      WHERE m.user_id = ? AND m.status = 'active'
      GROUP BY mt.tier
    `).all(userId) as { tier: MemoryTier; count: number }[];
    for (const row of rows) result[row.tier] = row.count;
    return result;
  }

  private createCue(memory: Memory): string {
    const entityNames = memory.entities.map(entity => entity.entity_name).filter(Boolean);
    const prefix = entityNames.length > 0 ? `${entityNames.slice(0, 4).join(', ')}: ` : '';
    return (prefix + memory.content).replace(/\s+/g, ' ').trim().slice(0, 240);
  }

  private isSafetyCritical(memory: Memory): boolean {
    return memory.entities.some(entity => entity.entity_type === 'allergen') ||
      /\b(allerg\w*|epipen|medical|medication|safety|must not|never)\b/i.test(memory.content);
  }

  private computeUtility(
    memory: Memory,
    accessCount: number,
    successfulUseCount: number,
    lastAccessedAt: string | null,
    pinned: boolean,
    now: Date
  ): number {
    if (pinned) return 1;
    const reference = new Date(lastAccessedAt || memory.last_recalled_at || memory.created_at);
    const ageDays = Math.max(0, now.getTime() - reference.getTime()) / 86_400_000;
    const recency = Math.exp(-ageDays / 30);
    const frequency = Math.min(1, Math.log1p(accessCount + memory.recall_count) / Math.log(11));
    const usefulness = accessCount === 0 ? 0 : successfulUseCount / accessCount;
    const typeValue = memory.type === 'procedural' ? 1 : memory.type === 'semantic' ? 0.6 : 0.2;
    return Math.min(1,
      0.45 * memory.importance +
      0.15 * memory.emotional_weight +
      0.15 * recency +
      0.10 * frequency +
      0.10 * usefulness +
      0.05 * typeValue
    );
  }

  private selectTier(current: MemoryTier, utility: number, pinned: boolean): MemoryTier {
    if (pinned) return 'hot';
    // Separate entry and exit thresholds prevent tier thrashing.
    if (current === 'hot') return utility < 0.62 ? 'warm' : 'hot';
    if (current === 'cold') return utility >= 0.48 ? 'warm' : 'cold';
    if (utility >= 0.75) return 'hot';
    if (utility < 0.32) return 'cold';
    return 'warm';
  }

  private rowToState(row: any): MemoryTierState {
    return {
      memory_id: row.memory_id,
      tier: row.tier,
      cue: row.cue,
      access_count: row.access_count,
      successful_use_count: row.successful_use_count,
      last_accessed_at: row.last_accessed_at,
      utility_score: row.utility_score,
      pinned: Boolean(row.pinned),
    };
  }
}

/** Searches the smallest useful tier set and expands only when evidence is weak. */
export class TieredMemoryRetriever {
  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly vectorStore: VectorStore,
    private readonly embedder: EmbeddingProvider | null,
    private readonly tierManager: MemoryTierManager,
    private readonly graphStore: GraphStore | null = null
  ) {}

  public async retrieve(
    query: string,
    now: Date,
    options: TieredRetrievalOptions = {}
  ): Promise<TieredRetrievalResult> {
    const userId = options.userId || 'default_user';
    const limit = options.limit || 5;
    const confidenceThreshold = options.confidenceThreshold ?? 0.62;
    const confidenceSimilarityThreshold = options.confidenceSimilarityThreshold ?? 0.55;
    const minimumResults = options.minimumResults ?? 1;
    this.tierManager.ensureUser(userId);
    const queryEmbedding = this.embedder ? await this.embedder.embed(query) : undefined;

    const trace: TieredRetrievalTrace = {
      searchedTiers: [], candidateCounts: {}, escalated: false,
    };
    const stages: MemoryTier[][] = [['hot'], ['hot', 'warm'], ['hot', 'warm', 'cold']];
    let results: RecallResult[] = [];

    for (const tiers of stages) {
      const newestTier = tiers[tiers.length - 1];
      const candidateIds = this.tierManager.idsForUser(userId, tiers);
      trace.searchedTiers.push(newestTier);
      trace.candidateCounts[newestTier] = candidateIds.size;
      results = await retrieveMemories(
        query, this.memoryStore, this.vectorStore, this.embedder, now,
        {
          ...options,
          userId,
          limit,
          graphStore: this.graphStore,
          candidateMemoryIds: candidateIds,
          queryEmbedding,
        }
      );
      const confident = results.length >= minimumResults &&
        (results[0]?.final_score ?? 0) >= confidenceThreshold &&
        (results[0]?.similarity_score ?? 0) >= confidenceSimilarityThreshold;
      if (confident || newestTier === 'cold') break;
      trace.escalated = true;
    }

    for (const result of results) this.tierManager.recordAccess(result.memory, now);
    return { results, trace };
  }
}
