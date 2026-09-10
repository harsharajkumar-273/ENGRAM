// ============================================
// Engram Agent — Cognitive Memory Interaction Loop
// ============================================

import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { 
  EngineConfig, 
  Memory, 
  Message, 
  TimeProvider, 
  EntityLink 
} from './core/types.js';
import { 
  DEFAULT_CONFIG, 
  RealTimeProvider, 
  SimulatedTimeProvider,
  getBaseHalfLife 
} from './core/types.js';
import { MemoryStore } from './storage/memory-store.js';
import { VectorStore } from './storage/vector-store.js';
import { GraphStore } from './storage/graph-store.js';
import { extractMemories } from './core/extraction.js';
import { retrieveMemories } from './recall/retrieval.js';
import { runDecaySweep, type DecaySweepReport } from './processes/decay-sweep.js';
import { detectContradictions, resolveContradictions } from './processes/contradiction.js';
import { ConsolidationEngine } from './processes/consolidation.js';
import { detectProceduralPatterns } from './processes/procedural.js';
import type { LLMProvider, EmbeddingProvider } from './providers/interface.js';

export interface ChatResult {
  response: string;
  recalledMemories: Memory[];
  extractedMemories: Memory[];
}

export class EngramAgent {
  public readonly memoryStore: MemoryStore;
  public readonly vectorStore: VectorStore;
  public readonly graphStore: GraphStore;
  private db: Database.Database;
  private llm: LLMProvider;
  private embedder: EmbeddingProvider | null;
  private config: EngineConfig;
  private timeProvider: TimeProvider;
  private userId: string;
  private sessionId: string;
  private workingMemory: Message[] = [];
  public debugMode = false;

  constructor(
    db: Database.Database,
    llm: LLMProvider,
    embedder: EmbeddingProvider | null = null,
    config: EngineConfig = DEFAULT_CONFIG,
    timeProvider: TimeProvider = new RealTimeProvider(),
    userId = 'default_user',
    sessionId = uuidv4()
  ) {
    this.db = db;
    this.memoryStore = new MemoryStore(db);
    this.vectorStore = new VectorStore(db);
    this.graphStore = new GraphStore(db);
    this.llm = llm;
    this.embedder = embedder;
    this.config = config;
    this.timeProvider = timeProvider;
    this.userId = userId;
    this.sessionId = sessionId;
  }

  /**
   * Recalls the most relevant active memories for a given query,
   * combining semantic relevance, real-time Ebbinghaus salience,
   * and spreading activation across the entity graph.
   */
  public async recall(query: string, limit = 5, userId?: string): Promise<Memory[]> {
    const results = await retrieveMemories(
      query,
      this.memoryStore,
      this.vectorStore,
      this.embedder,
      this.timeProvider.now(),
      {
        userId: userId || this.userId,
        limit,
        minSimilarity: 0.25,
        pruningThreshold: this.config.pruning_threshold,
        graphStore: this.graphStore
      }
    );

    return results.map(r => r.memory);
  }

  /**
   * Full conversational interaction turn:
   * 1. Recall relevant memories
   * 2. Formulate prompt with memory injection and working memory
   * 3. Generate response with LLM
   * 4. Update working memory
   * 5. Extract, score, deduplicate, and persist new memories
   */
  public async chat(userMessage: string): Promise<ChatResult> {
    const nowIso = this.timeProvider.now().toISOString();

    // 1. Recall context
    const recalledMemories = await this.recall(userMessage, this.config.max_recall_results);

    // Update recall count and last_recalled_at for recalled memories
    for (const mem of recalledMemories) {
      this.memoryStore.updateRecallStats(mem.id, nowIso);
    }

    // 2. Build system instructions with injected persistent memory
    let systemPrompt = `You are Engram, an intelligent assistant equipped with human-like cognitive memory.
You remember relevant facts, life events, and preferences about the user seamlessly.`;

    if (recalledMemories.length > 0) {
      const memoryLines = recalledMemories.map(m => 
        `- [${m.type.toUpperCase()} | Importance: ${m.importance.toFixed(2)}] ${m.content}`
      ).join('\n');

      systemPrompt += `\n\n## Relevant Persistent Memories About This User:\n${memoryLines}\n
Apply these memories naturally when formulating your reply. Never say "According to my memories" or "I recall from my database" unless directly asked how you know.`;
    }

    // 3. Assemble message history
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...this.workingMemory,
      { role: 'user', content: userMessage }
    ];

    // 4. Generate assistant response
    const assistantResponse = await this.llm.chat(messages);

    // 5. Update working memory (buffer of recent ~8 turns)
    this.workingMemory.push({ role: 'user', content: userMessage });
    this.workingMemory.push({ role: 'assistant', content: assistantResponse });
    if (this.workingMemory.length > 8) {
      this.workingMemory = this.workingMemory.slice(-8);
    }

    // 6. Extract memories from the turn
    const extractedDrafts = await extractMemories(
      userMessage,
      assistantResponse,
      this.llm,
      this.workingMemory
    );

    const newlyStoredMemories: Memory[] = [];

    for (const draft of extractedDrafts) {
      let isDuplicate = false;

      // Deduplication check via embedding similarity
      if (this.embedder) {
        try {
          const draftEmbedding = await this.embedder.embed(draft.content);
          const matches = this.vectorStore.search(draftEmbedding, 1, this.config.dedup_threshold);

          if (matches.length > 0) {
            // Near-duplicate found! Reinforce existing memory instead of creating duplicate
            const existingId = matches[0].memory_id;
            this.memoryStore.updateRecallStats(existingId, nowIso);
            isDuplicate = true;

            if (this.debugMode) {
              console.log(`[Engram Dedup] Reinforced existing memory ${existingId} (similarity: ${matches[0].similarity.toFixed(3)})`);
            }
          } else {
            // Not a duplicate: find candidates and evaluate contradictions
            const candidateMatches = this.vectorStore.search(
              draftEmbedding,
              10,
              this.config.contradiction_similarity_threshold ?? 0.25
            );
            const candidates: Memory[] = [];
            for (const cm of candidateMatches) {
              const cand = this.memoryStore.getById(cm.memory_id);
              if (cand && cand.status === 'active' && cand.user_id === this.userId) {
                candidates.push(cand);
              }
            }

            const newMem = this.createMemoryRecord(draft, nowIso);
            this.memoryStore.create(newMem);
            this.vectorStore.store(newMem.id, draftEmbedding);
            newlyStoredMemories.push(newMem);

            if (candidates.length > 0) {
              try {
                const evals = await detectContradictions(newMem, candidates, this.llm);
                const resolved = resolveContradictions(newMem, evals, this.memoryStore, this.db, nowIso);
                if (this.debugMode && resolved.length > 0) {
                  console.log(`[Engram Contradiction] Resolved ${resolved.length} contradiction(s) for "${newMem.content}"`);
                }
              } catch (cErr) {
                if (this.debugMode) {
                  console.warn('[Engram Contradiction] Contradiction evaluation failed:', cErr);
                }
              }
            }
          }
        } catch (embErr) {
          if (this.debugMode) {
            console.warn('[Engram Dedup] Embedding failed during dedup, creating record directly:', embErr);
          }
        }
      }

      if (!isDuplicate && newlyStoredMemories.every(m => m.content !== draft.content)) {
        // Fallback or non-duplicate case if embedding was skipped
        const newMem = this.createMemoryRecord(draft, nowIso);
        const candidates = this.memoryStore.getActiveByUser(this.userId).slice(0, 10);
        this.memoryStore.create(newMem);
        newlyStoredMemories.push(newMem);

        if (candidates.length > 0) {
          try {
            const evals = await detectContradictions(newMem, candidates, this.llm);
            resolveContradictions(newMem, evals, this.memoryStore, this.db, nowIso);
          } catch {}
        }
      }
    }

    return {
      response: assistantResponse,
      recalledMemories,
      extractedMemories: newlyStoredMemories
    };
  }

  private getCategoriesForType(type: string): string[] {
    switch (type) {
      case 'allergen':
        return ['dietary_restrictions', 'health', 'food'];
      case 'dietary_preference':
        return ['dietary_restrictions', 'food', 'lifestyle'];
      case 'location':
        return ['places', 'geography'];
      case 'organization':
        return ['career', 'companies', 'work'];
      case 'person':
        return ['relationships', 'people'];
      case 'skill':
        return ['career', 'technology', 'expertise'];
      case 'preference':
        return ['tastes', 'preferences'];
      default:
        return ['general'];
    }
  }

  private createMemoryRecord(draft: {
    content: string;
    type: Memory['type'];
    importance: number;
    emotional_weight: number;
    entities: { name: string; type: any; relation: string }[];
    reasoning: string;
  }, nowIso: string): Memory {
    const memId = uuidv4();
    const entities: EntityLink[] = draft.entities.map(e => {
      const existing = this.graphStore.getEntityByName(e.name, e.type);
      const entityId = existing ? existing.id : uuidv4();

      this.graphStore.upsertEntity({
        id: entityId,
        name: e.name,
        type: e.type,
        categories: this.getCategoriesForType(e.type),
        first_seen_at: existing ? existing.first_seen_at : nowIso,
        last_seen_at: nowIso
      });

      this.graphStore.linkMemoryToEntity(memId, entityId, e.relation);

      return {
        entity_id: entityId,
        entity_name: e.name,
        entity_type: e.type,
        relation: e.relation
      };
    });

    return {
      id: memId,
      type: draft.type,
      status: 'active',
      content: draft.content,
      source_turn_id: uuidv4(),
      importance: draft.importance,
      emotional_weight: draft.emotional_weight,
      recall_count: 0,
      base_half_life_hours: getBaseHalfLife(draft.type, this.config),
      strengthening_factor: this.config.strengthening_factor,
      created_at: nowIso,
      last_recalled_at: nowIso,
      entities,
      superseded_by: null,
      consolidated_from: [],
      user_id: this.userId,
      session_id: this.sessionId
    };
  }

  /**
   * Resets the working memory conversational buffer.
   */
  public clearWorkingMemory(): void {
    this.workingMemory = [];
  }

  /**
   * Directly stores a memory record with optional embedding.
   */
  public async addMemory(
    content: string,
    options: {
      type?: Memory['type'];
      importance?: number;
      emotionalWeight?: number;
      userId?: string;
    } = {}
  ): Promise<Memory> {
    const nowIso = this.timeProvider.now().toISOString();
    const userId = options.userId || this.userId;
    const type = options.type || 'semantic';
    const importance = options.importance ?? 0.7;
    const emotionalWeight = options.emotionalWeight ?? 0.0;

    const memory: Memory = {
      id: uuidv4(),
      type,
      status: 'active',
      content,
      source_turn_id: 'direct_api',
      importance,
      emotional_weight: emotionalWeight,
      recall_count: 0,
      base_half_life_hours: getBaseHalfLife(type, this.config),
      strengthening_factor: this.config.strengthening_factor,
      created_at: nowIso,
      last_recalled_at: nowIso,
      entities: [],
      superseded_by: null,
      consolidated_from: [],
      user_id: userId,
      session_id: this.sessionId,
    };

    this.memoryStore.create(memory);

    if (this.embedder) {
      try {
        const emb = await this.embedder.embed(content);
        this.vectorStore.store(memory.id, emb);
      } catch (e) {
        if (this.debugMode) {
          console.warn('[Engram] Embedding generation failed for manual memory:', e);
        }
      }
    }

    return memory;
  }

  /**
   * Returns memory count statistics for this user or a specified user.
   */
  public getStats(userId?: string) {
    return this.memoryStore.countByUser(userId || this.userId);
  }

  /**
   * Returns all active memories for this user or a specified user.
   */
  public getActiveMemories(userId?: string): Memory[] {
    return this.memoryStore.getActiveByUser(userId || this.userId);
  }

  /**
   * Executes a background decay sweep to transition low-salience memories to dormant
   * and purge expired dormant records.
   */
  public runDecaySweep(gracePeriodHours?: number): DecaySweepReport {
    return runDecaySweep(
      this.memoryStore,
      this.vectorStore,
      this.timeProvider.now(),
      this.config,
      gracePeriodHours
    );
  }

  /**
   * Returns the agent's current reference timestamp.
   */
  public getCurrentTime(): Date {
    return this.timeProvider.now();
  }

  /**
   * Advances the agent's clock by a specified number of hours.
   * Switches to SimulatedTimeProvider if currently using real system time.
   */
  public advanceTime(hours: number): Date {
    if ('advance' in this.timeProvider && typeof (this.timeProvider as any).advance === 'function') {
      (this.timeProvider as any).advance(hours);
    } else {
      const current = this.timeProvider.now();
      const sim = new SimulatedTimeProvider(current);
      sim.advance(hours);
      this.timeProvider = sim;
    }
    return this.timeProvider.now();
  }

  /**
   * Retrieves all detected contradictions from the audit log.
   */
  public getContradictions(limit = 50) {
    return this.memoryStore.getContradictions(limit);
  }

  /**
   * Retrieves all entities stored in the knowledge graph.
   */
  public getEntities() {
    return this.graphStore.getAllEntities();
  }

  /**
   * Returns a specific entity and its 1-hop connected neighbors and memories.
   */
  public getEntityGraph(name: string) {
    const entity = this.graphStore.getEntityByName(name);
    if (!entity) return null;

    const memoryIds = this.graphStore.getMemoriesForEntity(entity.id);
    const linkedMemories = memoryIds
      .map(id => this.memoryStore.getById(id))
      .filter((m): m is Memory => m !== null);

    const related = this.graphStore.getRelatedEntities(entity.id);

    return {
      entity,
      linkedMemories,
      relatedEntities: related
    };
  }

  /**
   * Executes a consolidation sleep pass: clusters related episodic memories,
   * synthesizes an abstractive semantic narrative, and retires source fragments.
   */
  public async consolidate(): Promise<Memory[]> {
    const engine = new ConsolidationEngine(
      this.db,
      this.memoryStore,
      this.vectorStore,
      this.llm,
      this.embedder,
      this.graphStore
    );
    return engine.runConsolidationPass(this.userId, this.timeProvider.now().toISOString());
  }

  /**
   * Analyzes conversation history for recurring behavioral and coding patterns.
   */
  public async detectProcedural(): Promise<Memory[]> {
    return detectProceduralPatterns(
      this.workingMemory,
      this.memoryStore,
      this.llm,
      this.timeProvider.now().toISOString(),
      this.userId
    );
  }
}
