import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../src/storage/database.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import { VectorStore } from '../src/storage/vector-store.js';
import { GraphStore } from '../src/storage/graph-store.js';
import { computeSpreadingActivation } from '../src/recall/spreading-activation.js';
import { retrieveMemories } from '../src/recall/retrieval.js';
import { SimulatedTimeProvider, DEFAULT_CONFIG } from '../src/core/types.js';
import type { Memory, Entity } from '../src/core/types.js';
import type { EmbeddingProvider } from '../src/providers/interface.js';

class MockEmbedder implements EmbeddingProvider {
  public readonly name = 'MockEmbedder';
  public readonly dimensions = 3;
  private vectors = new Map<string, number[]>();

  register(keyword: string, vec: number[]) {
    this.vectors.set(keyword.toLowerCase(), vec);
  }

  async embed(text: string): Promise<number[]> {
    const lower = text.toLowerCase();
    for (const [kw, vec] of this.vectors.entries()) {
      if (lower.includes(kw)) return vec;
    }
    return [0.1, 0.1, 0.1]; // Low baseline vector
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

function createMem(id: string, content: string, overrides: Partial<Memory> = {}): Memory {
  const time = '2026-09-08T00:00:00.000Z';
  return {
    id,
    type: 'semantic',
    status: 'active',
    content,
    source_turn_id: 'turn_1',
    importance: 0.8,
    emotional_weight: 0.0,
    recall_count: 0,
    base_half_life_hours: 720,
    strengthening_factor: 0.5,
    created_at: time,
    last_recalled_at: time,
    entities: [],
    superseded_by: null,
    consolidated_from: [],
    user_id: 'default_user',
    session_id: 'session_1',
    ...overrides
  };
}

describe('Entity Graph Store & Traversal', () => {
  let db: any;
  let graphStore: GraphStore;

  beforeEach(() => {
    db = initDatabase(':memory:');
    graphStore = new GraphStore(db);
  });

  it('upserts entities with categories and retrieves them', () => {
    const entity: Entity = {
      id: 'e_peanuts',
      name: 'Peanuts',
      type: 'allergen',
      categories: ['dietary_restrictions', 'health', 'food'],
      first_seen_at: '2026-09-08T00:00:00.000Z',
      last_seen_at: '2026-09-08T00:00:00.000Z'
    };

    graphStore.upsertEntity(entity);

    const fetched = graphStore.getEntityById('e_peanuts');
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe('Peanuts');
    expect(fetched?.categories).toContain('dietary_restrictions');
    expect(fetched?.categories).toContain('health');
  });

  it('traverses 1-hop related entities via shared categories', () => {
    // Entity 1: Peanuts (dietary_restrictions)
    graphStore.upsertEntity({
      id: 'e_peanuts',
      name: 'Peanuts',
      type: 'allergen',
      categories: ['dietary_restrictions', 'food'],
      first_seen_at: '2026-09-08T00:00:00.000Z',
      last_seen_at: '2026-09-08T00:00:00.000Z'
    });

    // Entity 2: Vegetarian (dietary_restrictions)
    graphStore.upsertEntity({
      id: 'e_vegetarian',
      name: 'Vegetarian',
      type: 'dietary_preference',
      categories: ['dietary_restrictions', 'lifestyle'],
      first_seen_at: '2026-09-08T00:00:00.000Z',
      last_seen_at: '2026-09-08T00:00:00.000Z'
    });

    // Entity 3: Lisbon (places) - unrelated
    graphStore.upsertEntity({
      id: 'e_lisbon',
      name: 'Lisbon',
      type: 'location',
      categories: ['places'],
      first_seen_at: '2026-09-08T00:00:00.000Z',
      last_seen_at: '2026-09-08T00:00:00.000Z'
    });

    const relatedToPeanuts = graphStore.getRelatedEntities('e_peanuts');
    expect(relatedToPeanuts).toHaveLength(1);
    expect(relatedToPeanuts[0].entity.id).toBe('e_vegetarian');
    expect(relatedToPeanuts[0].sharedCategory).toBe('dietary_restrictions');
  });
});

describe('Associative Recall via Spreading Activation', () => {
  let db: any;
  let memoryStore: MemoryStore;
  let vectorStore: VectorStore;
  let graphStore: GraphStore;
  let embedder: MockEmbedder;
  let time: SimulatedTimeProvider;

  beforeEach(() => {
    db = initDatabase(':memory:');
    memoryStore = new MemoryStore(db);
    vectorStore = new VectorStore(db);
    graphStore = new GraphStore(db);
    embedder = new MockEmbedder();
    time = new SimulatedTimeProvider(new Date('2026-09-08T00:00:00.000Z'));
  });

  it('pulls in associated memories that vector search alone would miss', async () => {
    // Entities in shared category "dietary_restrictions"
    graphStore.upsertEntity({
      id: 'ent_veg',
      name: 'Vegetarian',
      type: 'dietary_preference',
      categories: ['dietary_restrictions'],
      first_seen_at: '2026-09-08T00:00:00.000Z',
      last_seen_at: '2026-09-08T00:00:00.000Z'
    });

    graphStore.upsertEntity({
      id: 'ent_peanut',
      name: 'Peanuts',
      type: 'allergen',
      categories: ['dietary_restrictions'],
      first_seen_at: '2026-09-08T00:00:00.000Z',
      last_seen_at: '2026-09-08T00:00:00.000Z'
    });

    // Memory 1: User is vegetarian
    const memVeg = createMem('mem_veg', 'User follows a strict vegetarian diet');
    memoryStore.create(memVeg);
    graphStore.linkMemoryToEntity('mem_veg', 'ent_veg', 'follows');
    // Vector for vegetarian: [1, 0, 0]
    vectorStore.store('mem_veg', [1.0, 0.0, 0.0]);

    // Memory 2: User is allergic to peanuts (orthognal vector [0, 1, 0] - zero cosine similarity to vegetarian query!)
    const memPeanut = createMem('mem_peanut', 'User is severely allergic to peanuts and peanut oil', { importance: 0.95 });
    memoryStore.create(memPeanut);
    graphStore.linkMemoryToEntity('mem_peanut', 'ent_peanut', 'allergic_to');
    vectorStore.store('mem_peanut', [0.0, 1.0, 0.0]);

    // Query is strictly about vegetarian food: query vector matches memVeg [1, 0, 0]
    embedder.register('vegetarian dinner', [1.0, 0.0, 0.0]);

    // First, recall WITHOUT graphStore: memPeanut has 0.0 similarity and will NOT be retrieved
    const resultsWithoutGraph = await retrieveMemories(
      'vegetarian dinner',
      memoryStore,
      vectorStore,
      embedder,
      time.now(),
      { limit: 5, graphStore: null }
    );
    expect(resultsWithoutGraph.map(r => r.memory.id)).toContain('mem_veg');
    expect(resultsWithoutGraph.map(r => r.memory.id)).not.toContain('mem_peanut');

    // Second, recall WITH graphStore (spreading activation active!):
    // memVeg is retrieved directly -> reaches Vegetarian entity -> hops across dietary_restrictions category
    // -> reaches Peanuts entity -> surfaces memPeanut!
    const resultsWithGraph = await retrieveMemories(
      'vegetarian dinner',
      memoryStore,
      vectorStore,
      embedder,
      time.now(),
      { limit: 5, graphStore }
    );

    const memoryIds = resultsWithGraph.map(r => r.memory.id);
    expect(memoryIds).toContain('mem_veg');
    expect(memoryIds).toContain('mem_peanut');

    const peanutResult = resultsWithGraph.find(r => r.memory.id === 'mem_peanut');
    expect(peanutResult?.association_boost).toBeGreaterThan(0);
  });
});
