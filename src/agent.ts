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
  getBaseHalfLife 
} from './core/types.js';
import { MemoryStore } from './storage/memory-store.js';
import { VectorStore } from './storage/vector-store.js';
import { extractMemories } from './core/extraction.js';
import type { LLMProvider, EmbeddingProvider } from './providers/interface.js';

export interface ChatResult {
  response: string;
  recalledMemories: Memory[];
  extractedMemories: Memory[];
}

export class EngramAgent {
  public readonly memoryStore: MemoryStore;
  public readonly vectorStore: VectorStore;
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
    this.memoryStore = new MemoryStore(db);
    this.vectorStore = new VectorStore(db);
    this.llm = llm;
    this.embedder = embedder;
    this.config = config;
    this.timeProvider = timeProvider;
    this.userId = userId;
    this.sessionId = sessionId;
  }

  /**
   * Recalls the most relevant active memories for a given query.
   */
  public async recall(query: string, limit = 5): Promise<Memory[]> {
    if (this.embedder) {
      try {
        const queryVec = await this.embedder.embed(query);
        const searchResults = this.vectorStore.search(queryVec, limit * 2, 0.25);
        
        const memories: Memory[] = [];
        for (const res of searchResults) {
          const mem = this.memoryStore.getById(res.memory_id);
          if (mem && mem.status === 'active' && mem.user_id === this.userId) {
            memories.push(mem);
            if (memories.length >= limit) break;
          }
        }
        return memories;
      } catch (err) {
        if (this.debugMode) {
          console.warn('[Engram Recall] Embedding search failed, falling back to recent active memories:', err);
        }
      }
    }

    // Fallback if no embedding provider or embedding fails: return highest-importance active memories
    const active = this.memoryStore.getActiveByUser(this.userId);
    return active
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
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
            // Not a duplicate: store with embedding
            const newMem = this.createMemoryRecord(draft, nowIso);
            this.memoryStore.create(newMem);
            this.vectorStore.store(newMem.id, draftEmbedding);
            newlyStoredMemories.push(newMem);
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
        this.memoryStore.create(newMem);
        newlyStoredMemories.push(newMem);
      }
    }

    return {
      response: assistantResponse,
      recalledMemories,
      extractedMemories: newlyStoredMemories
    };
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
    const entities: EntityLink[] = draft.entities.map(e => ({
      entity_id: uuidv4(),
      entity_name: e.name,
      entity_type: e.type,
      relation: e.relation
    }));

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
   * Returns memory count statistics for this user.
   */
  public getStats() {
    return this.memoryStore.countByUser(this.userId);
  }

  /**
   * Returns all active memories for this user.
   */
  public getActiveMemories(): Memory[] {
    return this.memoryStore.getActiveByUser(this.userId);
  }
}
