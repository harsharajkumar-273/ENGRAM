import { performance } from 'node:perf_hooks';
import { initDatabase } from '../src/storage/database.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import { VectorStore } from '../src/storage/vector-store.js';
import { MemoryTierManager, TieredMemoryRetriever } from '../src/recall/tiered-memory.js';
import { retrieveMemories } from '../src/recall/retrieval.js';
import type { Memory, MemoryTier } from '../src/core/types.js';

export interface AdaptiveBenchmarkResult {
  system: 'Flat full-precision' | 'Adaptive tiered';
  recallAt5: number;
  avgVectorComparisons: number;
  avgLatencyMs: number;
  embeddingCallsPerQuery: number;
  vectorBytes: number;
  storageReduction: number;
  coldEscalationRate: number;
  recallByTier: Record<MemoryTier, number>;
}

interface Fixture {
  memory: Memory;
  embedding: number[];
  tier: MemoryTier;
}

const DIMENSIONS = 96;
const MEMORY_COUNT = 1200;
const QUERY_COUNT = 100;

function seededUnitVector(seed: number): number[] {
  let state = seed >>> 0;
  const vector = Array.from({ length: DIMENSIONS }, () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  });
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map(value => value / norm);
}

function makeFixture(index: number): Fixture {
  // Production-like skew: a small hot set, a moderate warm set, and a large archive.
  const tier: MemoryTier = index < 60 ? 'hot' : index < 360 ? 'warm' : 'cold';
  const importance = tier === 'hot' ? 0.95 : tier === 'warm' ? 0.7 : 0.2;
  const timestamp = '2026-09-20T00:00:00.000Z';
  return {
    tier,
    embedding: seededUnitVector(index + 1),
    memory: {
      id: `memory-${index}`,
      type: tier === 'cold' ? 'episodic' : 'semantic',
      status: 'active',
      content: tier === 'hot' && index === 0
        ? 'User has a severe medication allergy safety constraint'
        : `Controlled ${tier} memory number ${index}`,
      source_turn_id: `turn-${index}`,
      importance,
      emotional_weight: tier === 'hot' ? 0.2 : 0,
      recall_count: 0,
      base_half_life_hours: tier === 'cold' ? 72 : 720,
      strengthening_factor: 0.5,
      created_at: timestamp,
      last_recalled_at: timestamp,
      entities: [],
      superseded_by: null,
      consolidated_from: [],
      user_id: 'benchmark-user',
      session_id: 'benchmark-session',
    },
  };
}

function queryIndices(): number[] {
  const hot = Array.from({ length: 60 }, (_, index) => index % 60);
  const warm = Array.from({ length: 30 }, (_, index) => 60 + index * 10);
  const cold = Array.from({ length: 10 }, (_, index) => 360 + index * 80);
  return [...hot, ...warm, ...cold].slice(0, QUERY_COUNT);
}

export async function runAdaptiveBenchmark(): Promise<AdaptiveBenchmarkResult[]> {
  const fixtures = Array.from({ length: MEMORY_COUNT }, (_, index) => makeFixture(index));
  const now = new Date('2026-09-20T00:00:00.000Z');

  const flatDb = initDatabase(':memory:');
  const flatMemories = new MemoryStore(flatDb);
  const flatVectors = new VectorStore(flatDb);
  const tieredDb = initDatabase(':memory:');
  const tieredMemories = new MemoryStore(tieredDb);
  const tieredVectors = new VectorStore(tieredDb);
  const tierManager = new MemoryTierManager(tieredDb, tieredVectors);

  for (const fixture of fixtures) {
    flatMemories.create(fixture.memory);
    flatVectors.store(fixture.memory.id, fixture.embedding);
    tieredMemories.create(fixture.memory);
    tieredVectors.store(fixture.memory.id, fixture.embedding);
    tierManager.ensure(fixture.memory);
  }

  let flatEmbeddingCalls = 0;
  let tieredEmbeddingCalls = 0;
  let currentQueryVector = fixtures[0].embedding;
  const flatEmbedder = {
    name: 'controlled-flat', dimensions: DIMENSIONS,
    embed: async () => { flatEmbeddingCalls++; return currentQueryVector; },
    embedBatch: async (texts: string[]) => texts.map(() => currentQueryVector),
  };
  const tieredEmbedder = {
    name: 'controlled-tiered', dimensions: DIMENSIONS,
    embed: async () => { tieredEmbeddingCalls++; return currentQueryVector; },
    embedBatch: async (texts: string[]) => texts.map(() => currentQueryVector),
  };
  const tieredRetriever = new TieredMemoryRetriever(
    tieredMemories, tieredVectors, tieredEmbedder, tierManager
  );

  let flatHits = 0;
  let tieredHits = 0;
  let coldEscalations = 0;
  const tierTotals: Record<MemoryTier, number> = { hot: 0, warm: 0, cold: 0 };
  const flatTierHits: Record<MemoryTier, number> = { hot: 0, warm: 0, cold: 0 };
  const tieredTierHits: Record<MemoryTier, number> = { hot: 0, warm: 0, cold: 0 };
  let flatLatency = 0;
  let tieredLatency = 0;
  flatVectors.resetSearchComparisons();
  tieredVectors.resetSearchComparisons();

  for (const index of queryIndices()) {
    const expectedTier = fixtures[index].tier;
    tierTotals[expectedTier]++;
    currentQueryVector = fixtures[index].embedding;
    let started = performance.now();
    const flat = await retrieveMemories(
      `query-${index}`, flatMemories, flatVectors, flatEmbedder, now,
      { userId: 'benchmark-user', limit: 5, minSimilarity: 0.25 }
    );
    flatLatency += performance.now() - started;
    if (flat.some(result => result.memory.id === `memory-${index}`)) {
      flatHits++;
      flatTierHits[expectedTier]++;
    }

    started = performance.now();
    const tiered = await tieredRetriever.retrieve(`query-${index}`, now, {
      userId: 'benchmark-user', limit: 5, minSimilarity: 0.25,
    });
    tieredLatency += performance.now() - started;
    if (tiered.results.some(result => result.memory.id === `memory-${index}`)) {
      tieredHits++;
      tieredTierHits[expectedTier]++;
    }
    if (tiered.trace.searchedTiers.includes('cold')) coldEscalations++;
  }

  const flatStorage = flatVectors.getStorageStats();
  const tieredStorage = tieredVectors.getStorageStats();
  const flatBytes = flatStorage.fullPrecisionBytes + flatStorage.coldBytes;
  const tieredBytes = tieredStorage.fullPrecisionBytes + tieredStorage.coldBytes;
  const queries = queryIndices().length;

  flatDb.close();
  tieredDb.close();

  return [
    {
      system: 'Flat full-precision',
      recallAt5: flatHits / queries,
      avgVectorComparisons: flatVectors.getSearchComparisons() / queries,
      avgLatencyMs: flatLatency / queries,
      embeddingCallsPerQuery: flatEmbeddingCalls / queries,
      vectorBytes: flatBytes,
      storageReduction: 0,
      coldEscalationRate: 1,
      recallByTier: {
        hot: flatTierHits.hot / tierTotals.hot,
        warm: flatTierHits.warm / tierTotals.warm,
        cold: flatTierHits.cold / tierTotals.cold,
      },
    },
    {
      system: 'Adaptive tiered',
      recallAt5: tieredHits / queries,
      avgVectorComparisons: tieredVectors.getSearchComparisons() / queries,
      avgLatencyMs: tieredLatency / queries,
      embeddingCallsPerQuery: tieredEmbeddingCalls / queries,
      vectorBytes: tieredBytes,
      storageReduction: 1 - tieredBytes / flatBytes,
      coldEscalationRate: coldEscalations / queries,
      recallByTier: {
        hot: tieredTierHits.hot / tierTotals.hot,
        warm: tieredTierHits.warm / tierTotals.warm,
        cold: tieredTierHits.cold / tierTotals.cold,
      },
    },
  ];
}
