import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/storage/database.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import { VectorStore } from '../src/storage/vector-store.js';
import { MemoryTierManager, TieredMemoryRetriever } from '../src/recall/tiered-memory.js';
import type { Memory } from '../src/core/types.js';

const NOW = new Date('2026-09-17T00:00:00.000Z');

function memory(id: string, content: string, importance: number, userId = 'u1'): Memory {
  return {
    id, type: 'semantic', status: 'active', content, source_turn_id: 't1',
    importance, emotional_weight: 0, recall_count: 0,
    base_half_life_hours: 720, strengthening_factor: 0.5,
    created_at: NOW.toISOString(), last_recalled_at: NOW.toISOString(),
    entities: [], superseded_by: null, consolidated_from: [],
    user_id: userId, session_id: 's1',
  };
}

describe('Adaptive tiered memory', () => {
  it('keeps one canonical record while assigning hot, warm, and cold retrieval tiers', () => {
    const db = initDatabase(':memory:');
    const store = new MemoryStore(db);
    const manager = new MemoryTierManager(db);
    const hot = memory('hot', 'User has a severe peanut allergy', 0.95);
    const warm = memory('warm', 'User works in software', 0.7);
    const cold = memory('cold', 'User ate toast once', 0.2);
    store.create(hot); store.create(warm); store.create(cold);

    manager.ensureUser('u1');

    expect(manager.get('hot')?.tier).toBe('hot');
    expect(manager.get('hot')?.pinned).toBe(true);
    expect(manager.get('warm')?.tier).toBe('warm');
    expect(manager.get('cold')?.tier).toBe('cold');
    expect(store.countByUser('u1').total).toBe(3);
  });

  it('answers from hot memory without scanning lower tiers', async () => {
    const db = initDatabase(':memory:');
    const store = new MemoryStore(db);
    const vectors = new VectorStore(db);
    const manager = new MemoryTierManager(db);
    const critical = memory('critical', 'User has a severe peanut allergy', 0.95);
    const archive = memory('archive', 'User ate toast once', 0.2);
    store.create(critical); store.create(archive);
    vectors.store(critical.id, [1, 0]);
    vectors.store(archive.id, [0, 1]);
    const embedder = {
      name: 'test', dimensions: 2,
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    };
    const retriever = new TieredMemoryRetriever(store, vectors, embedder, manager);

    const response = await retriever.retrieve('What foods are unsafe?', NOW, { userId: 'u1' });

    expect(response.results[0].memory.id).toBe('critical');
    expect(response.trace.searchedTiers).toEqual(['hot']);
    expect(response.trace.escalated).toBe(false);
  });

  it('progressively searches warm and cold memory when hot evidence is insufficient', async () => {
    const db = initDatabase(':memory:');
    const store = new MemoryStore(db);
    const vectors = new VectorStore(db);
    const manager = new MemoryTierManager(db);
    const archived = memory('archived', 'User visited Kyoto during spring', 0.2);
    store.create(archived);
    vectors.store(archived.id, [1, 0]);
    const embedder = {
      name: 'test', dimensions: 2,
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    };
    const retriever = new TieredMemoryRetriever(store, vectors, embedder, manager);

    const response = await retriever.retrieve('Where did I travel?', NOW, {
      userId: 'u1', confidenceThreshold: 0.2,
    });

    expect(response.results[0].memory.id).toBe('archived');
    expect(response.trace.searchedTiers).toEqual(['hot', 'warm', 'cold']);
    expect(response.trace.escalated).toBe(true);
    expect(manager.get('archived')?.access_count).toBe(1);
  });

  it('does not let a salient but weakly related hot memory block escalation', async () => {
    const db = initDatabase(':memory:');
    const store = new MemoryStore(db);
    const vectors = new VectorStore(db);
    const manager = new MemoryTierManager(db, vectors);
    const hot = memory('hot-distractor', 'User has an important unrelated safety rule', 0.95);
    hot.emotional_weight = 1;
    const warm = memory('warm-answer', 'User works at Acme', 0.7);
    store.create(hot); store.create(warm);
    vectors.store(hot.id, [0.4, 0.9165]);
    vectors.store(warm.id, [1, 0]);
    const embedder = {
      name: 'test', dimensions: 2,
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    };
    const retriever = new TieredMemoryRetriever(store, vectors, embedder, manager);

    const result = await retriever.retrieve('Where do I work?', NOW, { userId: 'u1' });

    expect(result.trace.searchedTiers).toEqual(['hot', 'warm']);
    expect(result.results[0].memory.id).toBe('warm-answer');
  });

  it('keeps tier state isolated by user', () => {
    const db = initDatabase(':memory:');
    const store = new MemoryStore(db);
    const manager = new MemoryTierManager(db);
    store.create(memory('u1-memory', 'User likes tea', 0.8, 'u1'));
    store.create(memory('u2-memory', 'User likes tea', 0.8, 'u2'));
    manager.ensureUser('u1');

    expect(manager.idsForUser('u1', ['warm'])).toEqual(new Set(['u1-memory']));
    expect(manager.idsForUser('u2', ['warm'])).toEqual(new Set());
  });

  it('uses a hot cache and a quantized cold index while embedding each query once', async () => {
    const db = initDatabase(':memory:');
    const store = new MemoryStore(db);
    const vectors = new VectorStore(db);
    const manager = new MemoryTierManager(db, vectors);
    const hot = memory('hot-vector', 'User has a medication safety constraint', 0.95);
    const cold = memory('cold-vector', 'User once visited a small museum', 0.2);
    store.create(hot); store.create(cold);
    const dense = Array.from({ length: 128 }, (_, index) => Math.sin(index));
    vectors.store(hot.id, dense);
    vectors.store(cold.id, dense);
    let embeddingCalls = 0;
    const embedder = {
      name: 'test', dimensions: dense.length,
      embed: async () => { embeddingCalls++; return dense; },
      embedBatch: async (texts: string[]) => texts.map(() => dense),
    };
    const retriever = new TieredMemoryRetriever(store, vectors, embedder, manager);

    manager.ensureUser('u1');
    const storage = vectors.getStorageStats();
    expect(storage.hotEntries).toBe(1);
    expect(storage.coldEntries).toBe(1);
    expect(storage.coldBytes).toBe(128);
    expect(storage.fullPrecisionBytes).toBe(128 * 4);

    await retriever.retrieve('museum', NOW, {
      userId: 'u1', confidenceThreshold: 2,
    });
    expect(embeddingCalls).toBe(1);
  });

  it('promotes useful memories from task feedback', () => {
    const db = initDatabase(':memory:');
    const store = new MemoryStore(db);
    const vectors = new VectorStore(db);
    const manager = new MemoryTierManager(db, vectors);
    const useful = memory('useful', 'User deployment workflow', 0.85);
    useful.emotional_weight = 0.2;
    store.create(useful);
    vectors.store(useful.id, [1, 0]);
    manager.ensure(useful);

    for (let index = 0; index < 5; index++) {
      manager.recordAccess(useful, NOW);
      manager.recordOutcome(useful, NOW, true);
    }

    expect(manager.get(useful.id)?.tier).toBe('hot');
    expect(manager.get(useful.id)?.successful_use_count).toBe(5);
    expect(vectors.getStorageStats().hotEntries).toBe(1);
  });

  it('never demotes pinned safety memory during rebalancing', () => {
    const db = initDatabase(':memory:');
    const store = new MemoryStore(db);
    const vectors = new VectorStore(db);
    const manager = new MemoryTierManager(db, vectors);
    const safety = memory('safety', 'User must never receive penicillin due to allergy', 0.1);
    safety.created_at = '2020-01-01T00:00:00.000Z';
    safety.last_recalled_at = safety.created_at;
    store.create(safety);
    vectors.store(safety.id, [1, 0]);
    manager.ensure(safety);

    manager.rebalance(store, 'u1', NOW);

    expect(manager.get(safety.id)?.tier).toBe('hot');
    expect(manager.get(safety.id)?.pinned).toBe(true);
  });

  it('excludes superseded vectors from every tier search', async () => {
    const db = initDatabase(':memory:');
    const store = new MemoryStore(db);
    const vectors = new VectorStore(db);
    const manager = new MemoryTierManager(db, vectors);
    const stale = memory('stale-tier', 'User lives in Berlin', 0.95);
    store.create(stale);
    vectors.store(stale.id, [1, 0]);
    manager.ensure(stale);
    store.updateStatus(stale.id, 'superseded', 'new-location');
    const embedder = {
      name: 'test', dimensions: 2,
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    };
    const retriever = new TieredMemoryRetriever(store, vectors, embedder, manager);

    const result = await retriever.retrieve('Where do I live?', NOW, { userId: 'u1' });

    expect(result.results).toEqual([]);
  });
});
