import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../src/storage/database.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import { VectorStore } from '../src/storage/vector-store.js';
import { retrieveMemories } from '../src/recall/retrieval.js';
import { EngramAgent } from '../src/agent.js';
import { SimulatedTimeProvider, DEFAULT_CONFIG } from '../src/core/types.js';
import type { Memory, Message, ChatOptions } from '../src/core/types.js';
import type { LLMProvider, EmbeddingProvider } from '../src/providers/interface.js';

class MockEmbedder implements EmbeddingProvider {
  public readonly name = 'MockEmbedder';
  public readonly dimensions = 3;
  private vectors: Map<string, number[]> = new Map();

  public register(keyword: string, vec: number[]) {
    this.vectors.set(keyword.toLowerCase(), vec);
  }

  async embed(text: string): Promise<number[]> {
    const lower = text.toLowerCase();
    for (const [kw, vec] of this.vectors.entries()) {
      if (lower.includes(kw)) return vec;
    }
    return [0.5, 0.5, 0.0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

class MockLLM implements LLMProvider {
  public readonly name = 'MockLLM';
  async chat(): Promise<string> { return 'OK'; }
  async chatJSON<T>(): Promise<T> { return { memories: [] } as T; }
}

function makeMemory(id: string, content: string, overrides: Partial<Memory> = {}): Memory {
  const time = '2026-09-08T00:00:00.000Z';
  return {
    id,
    type: 'semantic',
    status: 'active',
    content,
    source_turn_id: 't1',
    importance: 0.8,
    emotional_weight: 0.0,
    recall_count: 0,
    base_half_life_hours: 72,
    strengthening_factor: 0.5,
    created_at: time,
    last_recalled_at: time,
    entities: [],
    superseded_by: null,
    consolidated_from: [],
    user_id: 'default_user',
    session_id: 's1',
    ...overrides
  };
}

describe('Multi-Signal Retrieval Engine', () => {
  let db: any;
  let memoryStore: MemoryStore;
  let vectorStore: VectorStore;
  let embedder: MockEmbedder;
  let time: SimulatedTimeProvider;

  beforeEach(() => {
    db = initDatabase(':memory:');
    memoryStore = new MemoryStore(db);
    vectorStore = new VectorStore(db);
    embedder = new MockEmbedder();
    time = new SimulatedTimeProvider(new Date('2026-09-08T00:00:00.000Z'));
  });

  it('ranks memories using combined similarity and Ebbinghaus salience', async () => {
    // Target query vector: [1, 0, 0]
    embedder.register('typescript', [1, 0, 0]);

    // Memory 1: Near-perfect vector match [1, 0, 0], importance 0.5
    const mem1 = makeMemory('mem1', 'I write TypeScript code daily', { importance: 0.5 });
    memoryStore.create(mem1);
    vectorStore.store(mem1.id, [1, 0, 0]);

    // Memory 2: Moderate vector match [0.7, 0.7, 0], very high importance 0.95 and high emotional weight
    const mem2 = makeMemory('mem2', 'I lead the TypeScript compiler team', { importance: 0.95, emotional_weight: 0.8 });
    memoryStore.create(mem2);
    vectorStore.store(mem2.id, [0.7, 0.7, 0]);

    const results = await retrieveMemories(
      'typescript',
      memoryStore,
      vectorStore,
      embedder,
      time.now(),
      { limit: 2 }
    );

    expect(results).toHaveLength(2);
    expect(results[0].salience_score).toBeGreaterThan(0);
    expect(results[0].final_score).toBeGreaterThan(0);
  });

  it('excludes dormant memories from recall even if vector similarity is high', async () => {
    embedder.register('berlin', [1, 0, 0]);

    const nowIso = time.now().toISOString();

    // Memory has 100% similarity with query, but has importance 0.01 and low half-life
    const expiredMem = makeMemory('expired', 'I used to live in Berlin', {
      importance: 0.02,
      base_half_life_hours: 10,
      created_at: nowIso,
      last_recalled_at: nowIso
    });

    memoryStore.create(expiredMem);
    vectorStore.store(expiredMem.id, [1, 0, 0]);

    // Verify it is retrievable when fresh
    const freshRecall = await retrieveMemories('berlin', memoryStore, vectorStore, embedder, time.now());
    expect(freshRecall).toHaveLength(1);

    // Fast-forward 100 hours: salience drops below 0.01 (dormant)
    time.advance(100);

    const dormantRecall = await retrieveMemories('berlin', memoryStore, vectorStore, embedder, time.now());
    expect(dormantRecall).toHaveLength(0);
  });

  it('shifts ranking dynamically as memories decay over time', async () => {
    embedder.register('coding', [1, 0, 0]);

    const t0 = time.now().toISOString();

    // Memory A: Created at t0. High vector similarity [1, 0, 0], but short half-life (24h) and low recalls
    const staleMem = makeMemory('stale', 'Currently coding a prototype', {
      importance: 0.7,
      recall_count: 0,
      base_half_life_hours: 24,
      created_at: t0,
      last_recalled_at: t0
    });
    memoryStore.create(staleMem);
    vectorStore.store(staleMem.id, [1, 0, 0]);

    // Fast-forward 96 hours (4 days)
    time.advance(96);
    const t96 = time.now().toISOString();

    // Memory B: Freshly created at t96. Slightly lower similarity [0.85, 0.15, 0], but high fresh salience
    const freshMem = makeMemory('fresh', 'Started coding a major new system', {
      importance: 0.85,
      recall_count: 0,
      base_half_life_hours: 72,
      created_at: t96,
      last_recalled_at: t96
    });
    memoryStore.create(freshMem);
    vectorStore.store(freshMem.id, [0.85, 0.15, 0]);

    const results = await retrieveMemories('coding', memoryStore, vectorStore, embedder, time.now(), { limit: 2 });

    expect(results).toHaveLength(2);
    // Fresh memory should out-rank stale memory despite stale having slightly higher initial vector similarity
    expect(results[0].memory.id).toBe('fresh');
    expect(results[1].memory.id).toBe('stale');
    expect(results[0].salience_score).toBeGreaterThan(results[1].salience_score);
  });

  it('integrates with EngramAgent recall and advanceTime', async () => {
    embedder.register('peanut', [1, 0, 0]);
    const mockLlm = new MockLLM();
    const agent = new EngramAgent(db, mockLlm, embedder, DEFAULT_CONFIG, time);

    const mem = makeMemory('p1', 'Severe peanut allergy', { importance: 0.95 });
    memoryStore.create(mem);
    vectorStore.store(mem.id, [1, 0, 0]);

    const recalled = await agent.recall('peanut', 1);
    expect(recalled).toHaveLength(1);
    expect(recalled[0].content).toBe('Severe peanut allergy');

    // Test advanceTime
    const beforeTime = agent.getCurrentTime().getTime();
    agent.advanceTime(48);
    const afterTime = agent.getCurrentTime().getTime();
    expect(afterTime - beforeTime).toBe(48 * 60 * 60 * 1000);
  });
});
