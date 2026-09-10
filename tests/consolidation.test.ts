import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../src/storage/database.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import { VectorStore } from '../src/storage/vector-store.js';
import { ConsolidationEngine } from '../src/processes/consolidation.js';
import { detectProceduralPatterns } from '../src/processes/procedural.js';
import type { Memory, Message, ChatOptions } from '../src/core/types.js';
import type { LLMProvider, EmbeddingProvider } from '../src/providers/interface.js';

class MockLLM implements LLMProvider {
  public readonly name = 'MockLLM';
  public cannedJson: any[] = [];
  public cannedText = 'Response';

  async chat(): Promise<string> { return this.cannedText; }

  async chatJSON<T>(messages: Message[], schema: Record<string, unknown>, options?: ChatOptions): Promise<T> {
    if (this.cannedJson.length > 0) {
      return this.cannedJson.shift() as T;
    }
    return {} as T;
  }
}

class MockEmbedder implements EmbeddingProvider {
  public readonly name = 'MockEmbedder';
  public readonly dimensions = 3;
  private vectors = new Map<string, number[]>();

  register(text: string, vec: number[]) {
    this.vectors.set(text.toLowerCase(), vec);
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

function makeEpisodic(id: string, content: string, overrides: Partial<Memory> = {}): Memory {
  const time = '2026-09-08T00:00:00.000Z';
  return {
    id,
    type: 'episodic',
    status: 'active',
    content,
    source_turn_id: 'turn_1',
    importance: 0.6,
    emotional_weight: 0.2,
    recall_count: 1,
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

describe('Consolidation (The Sleep Pass)', () => {
  let db: any;
  let memoryStore: MemoryStore;
  let vectorStore: VectorStore;
  let mockLlm: MockLLM;
  let mockEmbedder: MockEmbedder;
  let engine: ConsolidationEngine;

  beforeEach(() => {
    db = initDatabase(':memory:');
    memoryStore = new MemoryStore(db);
    vectorStore = new VectorStore(db);
    mockLlm = new MockLLM();
    mockEmbedder = new MockEmbedder();
    engine = new ConsolidationEngine(db, memoryStore, vectorStore, mockLlm, mockEmbedder);
  });

  it('clusters related episodic memories using graph connectivity', () => {
    // 3 related hackathon memories with similar vector [1, 0, 0]
    const m1 = makeEpisodic('m1', 'Started building memory agent for hackathon');
    const m2 = makeEpisodic('m2', 'Debugged Ebbinghaus decay formulas in hackathon project');
    const m3 = makeEpisodic('m3', 'Submitted our cognitive memory system to hackathon judges');

    // 1 unrelated memory with orthogonal vector [0, 1, 0]
    const mUnrelated = makeEpisodic('m_unrelated', 'Bought new running shoes');

    memoryStore.create(m1);
    memoryStore.create(m2);
    memoryStore.create(m3);
    memoryStore.create(mUnrelated);

    vectorStore.store('m1', [1.0, 0.0, 0.0]);
    vectorStore.store('m2', [0.95, 0.05, 0.0]);
    vectorStore.store('m3', [0.9, 0.1, 0.0]);
    vectorStore.store('m_unrelated', [0.0, 1.0, 0.0]);

    const clusters = engine.findClusters('default_user', 0.70, 3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
    expect(clusters[0].map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('consolidates a cluster of episodic memories into a single semantic summary and retires sources', async () => {
    const m1 = makeEpisodic('m1', 'Started building memory agent for hackathon', { importance: 0.6 });
    const m2 = makeEpisodic('m2', 'Debugged decay formulas', { importance: 0.7 });
    const m3 = makeEpisodic('m3', 'Submitted project to hackathon', { importance: 0.8 });

    memoryStore.create(m1);
    memoryStore.create(m2);
    memoryStore.create(m3);

    mockLlm.cannedJson.push({
      summary: 'User successfully engineered and submitted a cognitive AI memory system for a hackathon, resolving complex decay algorithms along the way.',
      importance: 0.85,
      emotional_weight: 0.7,
      entities: [{ name: 'Hackathon', type: 'event', relation: 'completed' }]
    });

    const consolidated = await engine.consolidateCluster([m1, m2, m3], '2026-09-08T18:00:00.000Z');

    expect(consolidated).not.toBeNull();
    expect(consolidated?.type).toBe('semantic');
    expect(consolidated?.status).toBe('active');
    expect(consolidated?.consolidated_from).toEqual(['m1', 'm2', 'm3']);
    expect(consolidated?.importance).toBe(0.85);

    // Verify source memories are marked as consolidated
    expect(memoryStore.getById('m1')?.status).toBe('consolidated');
    expect(memoryStore.getById('m2')?.status).toBe('consolidated');
    expect(memoryStore.getById('m3')?.status).toBe('consolidated');

    // Verify active count: only the 1 consolidated memory is active
    const active = memoryStore.getActiveByUser('default_user');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(consolidated?.id);
  });
});

describe('Procedural Memory Detection', () => {
  let db: any;
  let memoryStore: MemoryStore;
  let mockLlm: MockLLM;

  beforeEach(() => {
    db = initDatabase(':memory:');
    memoryStore = new MemoryStore(db);
    mockLlm = new MockLLM();
  });

  it('detects and stores consistent interaction patterns as procedural memories', async () => {
    const conversationTurns: Message[] = [
      { role: 'user', content: 'Can you show me how to implement a quicksort? Please use TypeScript.' },
      { role: 'assistant', content: 'Here is quicksort in TypeScript...' },
      { role: 'user', content: 'Now write a binary search. Again, make sure it is strict TypeScript.' },
      { role: 'assistant', content: 'Here is binary search in TypeScript...' }
    ];

    mockLlm.cannedJson.push({
      patterns: [
        {
          rule: 'User consistently prefers code implementations written in TypeScript with strict typing',
          confidence: 0.92,
          category: 'code_preference'
        }
      ]
    });

    const detected = await detectProceduralPatterns(
      conversationTurns,
      memoryStore,
      mockLlm,
      '2026-09-08T00:00:00.000Z',
      'default_user'
    );

    expect(detected).toHaveLength(1);
    expect(detected[0].type).toBe('procedural');
    expect(detected[0].base_half_life_hours).toBe(2160); // 90 days
    expect(detected[0].content).toContain('TypeScript');

    const active = memoryStore.getActiveByUser('default_user');
    expect(active).toHaveLength(1);
    expect(active[0].type).toBe('procedural');
  });
});
