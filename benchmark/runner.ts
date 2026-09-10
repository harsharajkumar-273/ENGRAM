// ============================================
// Engram Comprehensive Benchmark Runner
// ============================================

import { initDatabase } from '../src/storage/database.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import { VectorStore } from '../src/storage/vector-store.js';
import { GraphStore } from '../src/storage/graph-store.js';
import { retrieveMemories } from '../src/recall/retrieval.js';
import { resolveContradictions } from '../src/processes/contradiction.js';
import { SimulatedTimeProvider, DEFAULT_CONFIG } from '../src/core/types.js';
import type { Memory } from '../src/core/types.js';

import { NaiveMemoryBaseline } from './baselines/naive.js';
import { SlidingWindowBaseline } from './baselines/sliding-window.js';
import { SynapseStyleBaseline } from './baselines/synapse-style.js';
import { 
  computeRecallAtK, 
  computePrecisionAtK, 
  computeStalenessResistance, 
  computeTokenCost 
} from './metrics.js';

interface BenchmarkScorecard {
  system: string;
  recall: number;
  precision: number;
  stalenessResistance: number;
  avgTokenCost: number;
  finalActiveCount: number;
}

// 4-dimensional synthetic semantic embeddings for controlled testing
const VECTORS: Record<string, number[]> = {
  berlin: [1.0, 0.0, 0.0, 0.0],
  lisbon: [0.6, 0.8, 0.0, 0.0], // City concept space
  bmw_engineer: [0.0, 1.0, 0.0, 0.0],
  stripe: [0.0, 0.8, 0.6, 0.0], // Tech job space
  bakery: [0.0, 0.2, 0.0, 0.9], // Non-tech food business
  peanut_allergy: [0.0, 0.0, 1.0, 0.0],
  dinner_query: [0.8, 0.0, 0.0, 0.0],
  work_query: [0.0, 0.9, 0.2, 0.0],
  location_query: [0.9, 0.1, 0.0, 0.0],
  trivial_pasta: [0.2, 0.0, 0.1, 0.2]
};

export async function runBenchmark(): Promise<BenchmarkScorecard[]> {
  const clock = new SimulatedTimeProvider(new Date('2026-09-01T00:00:00.000Z'));

  // 1. Initialize Engram
  const db = initDatabase(':memory:');
  const memoryStore = new MemoryStore(db);
  const vectorStore = new VectorStore(db);
  const graphStore = new GraphStore(db);

  // 2. Initialize Baselines
  const naive = new NaiveMemoryBaseline();
  const sliding = new SlidingWindowBaseline(4);
  const synapse = new SynapseStyleBaseline(72);

  // Mock embedding provider for Engram
  const mockEmbedder = {
    name: 'BenchmarkEmbedder',
    dimensions: 4,
    embed: async (text: string) => {
      const lower = text.toLowerCase();
      for (const [key, vec] of Object.entries(VECTORS)) {
        if (lower.includes(key.replace('_', ' '))) return vec;
      }
      return [0.2, 0.2, 0.2, 0.2];
    },
    embedBatch: async (texts: string[]) => Promise.all(texts.map(t => mockEmbedder.embed(t)))
  };

  function storeMemoryAll(
    id: string,
    content: string,
    vec: number[],
    type: Memory['type'],
    importance: number,
    entities: { name: string; type: any; category: string }[] = []
  ) {
    const nowIso = clock.now().toISOString();
    const mem: Memory = {
      id,
      type,
      status: 'active',
      content,
      source_turn_id: 'benchmark_turn',
      importance,
      emotional_weight: 0.1,
      recall_count: 0,
      base_half_life_hours: type === 'semantic' ? 720 : 72,
      strengthening_factor: 0.5,
      created_at: nowIso,
      last_recalled_at: nowIso,
      entities: entities.map(e => ({ entity_id: e.name, entity_name: e.name, entity_type: e.type, relation: 'associated' })),
      superseded_by: null,
      consolidated_from: [],
      user_id: 'bench_user',
      session_id: 'bench_session'
    };

    // Engram store
    memoryStore.create(mem);
    vectorStore.store(id, vec);
    for (const ent of entities) {
      graphStore.upsertEntity({
        id: ent.name,
        name: ent.name,
        type: ent.type,
        categories: [ent.category],
        first_seen_at: nowIso,
        last_seen_at: nowIso
      });
      graphStore.linkMemoryToEntity(id, ent.name, 'associated');
    }

    // Baselines store
    naive.store(mem, vec);
    sliding.store(mem, vec);
    synapse.store(mem, vec);
  }

  // --- Scenario Execution ---

  // Day 1: User introduces themselves
  storeMemoryAll('m1', 'User lives in Berlin', VECTORS.berlin, 'semantic', 0.8, [{ name: 'Berlin', type: 'location', category: 'places' }]);
  storeMemoryAll('m2', 'User works at BMW as a data scientist', VECTORS.bmw_engineer, 'semantic', 0.8, [{ name: 'BMW', type: 'organization', category: 'work' }]);
  storeMemoryAll('m3', 'User had delicious pasta for lunch', VECTORS.trivial_pasta, 'episodic', 0.2);

  // Day 10: User reveals life-critical allergy
  clock.advance(24 * 10);
  storeMemoryAll('m4', 'User has a severe peanut allergy and carries an EpiPen', VECTORS.peanut_allergy, 'semantic', 0.95, [
    { name: 'Peanuts', type: 'allergen', category: 'dietary_restrictions' }
  ]);

  // Day 20: User moves to Lisbon and starts at Stripe (CONTRADICTION with Berlin & BMW)
  clock.advance(24 * 10);
  const now20 = clock.now().toISOString();
  storeMemoryAll('m5', 'User relocated and now lives in Lisbon', VECTORS.lisbon, 'semantic', 0.85, [{ name: 'Lisbon', type: 'location', category: 'places' }]);
  storeMemoryAll('m6', 'User joined Stripe as a software engineer', VECTORS.stripe, 'semantic', 0.85, [{ name: 'Stripe', type: 'organization', category: 'work' }]);

  // Resolve contradictions in Engram
  resolveContradictions(
    memoryStore.getById('m5')!,
    [{ old_memory_id: 'm1', classification: 'CONTRADICTION', confidence: 0.95, reasoning: 'Relocation' }],
    memoryStore,
    db,
    now20
  );
  resolveContradictions(
    memoryStore.getById('m6')!,
    [{ old_memory_id: 'm2', classification: 'CONTRADICTION', confidence: 0.93, reasoning: 'Employer shift' }],
    memoryStore,
    db,
    now20
  );

  // Day 40: User changes career to open a bakery (CONTRADICTION with Stripe)
  clock.advance(24 * 20);
  const now40 = clock.now().toISOString();
  storeMemoryAll('m7', 'User left tech to open an artisanal bakery', VECTORS.bakery, 'semantic', 0.85, [{ name: 'Bakery', type: 'organization', category: 'work' }]);
  resolveContradictions(
    memoryStore.getById('m7')!,
    [{ old_memory_id: 'm6', classification: 'CONTRADICTION', confidence: 0.96, reasoning: 'Career change' }],
    memoryStore,
    db,
    now40
  );

  // --- Evaluation Test Queries ---
  const testQueries = [
    {
      query: 'Where do I currently live?',
      vec: VECTORS.location_query,
      expected: ['lisbon'],
      outdated: ['berlin']
    },
    {
      query: 'What is my current job or profession?',
      vec: VECTORS.work_query,
      expected: ['bakery'],
      outdated: ['bmw', 'stripe', 'data scientist']
    },
    {
      query: 'What dietary or safety instructions should you remember for dinner?',
      vec: VECTORS.dinner_query,
      expected: ['peanut allergy', 'epipen'],
      outdated: []
    }
  ];

  // Evaluate each system
  const systems = [
    { name: 'Engram (Cognitive)', recallFn: async (vec: number[], q: string) => {
      const results = await retrieveMemories(q, memoryStore, vectorStore, mockEmbedder, clock.now(), { limit: 4, graphStore, userId: 'bench_user' });
      return results.map(r => r.memory);
    }, getCount: () => memoryStore.getActiveByUser('bench_user').length },
    { name: 'Naive RAG (Vector Dump)', recallFn: async (vec: number[]) => naive.recall(vec, 4), getCount: () => naive.getActiveCount() },
    { name: 'Sliding Window (Last 4)', recallFn: async (vec: number[]) => sliding.recall(vec, 4), getCount: () => sliding.getActiveCount() },
    { name: 'Synapse-Style (Fixed Decay)', recallFn: async (vec: number[]) => synapse.recall(vec, clock.now(), 4), getCount: () => synapse.getActiveCount() }
  ];

  const results: BenchmarkScorecard[] = [];

  for (const sys of systems) {
    let totalRecall = 0;
    let totalPrecision = 0;
    let totalStalenessRes = 0;
    let totalTokens = 0;

    for (const tq of testQueries) {
      const retrieved = await sys.recallFn(tq.vec, tq.query);
      totalRecall += computeRecallAtK(retrieved, tq.expected);
      totalPrecision += computePrecisionAtK(retrieved, tq.expected);
      totalStalenessRes += computeStalenessResistance(retrieved, tq.outdated);
      totalTokens += computeTokenCost(retrieved);
    }

    results.push({
      system: sys.name,
      recall: totalRecall / testQueries.length,
      precision: totalPrecision / testQueries.length,
      stalenessResistance: totalStalenessRes / testQueries.length,
      avgTokenCost: Math.round(totalTokens / testQueries.length),
      finalActiveCount: sys.getCount()
    });
  }

  return results;
}
