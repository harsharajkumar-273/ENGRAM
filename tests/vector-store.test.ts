import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../src/storage/database.js';
import { VectorStore, cosineSimilarity } from '../src/storage/vector-store.js';

describe('VectorStore', () => {
  let db: any;
  let store: VectorStore;

  beforeEach(() => {
    db = initDatabase(':memory:');
    store = new VectorStore(db);
  });

  it('should store and retrieve an embedding', () => {
    const id = 'mem_1';
    const vec = [0.1, 0.2, 0.3];
    store.store(id, vec);
    
    const retrieved = store.getEmbedding(id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.length).toBe(vec.length);
    retrieved!.forEach((val, i) => {
      expect(val).toBeCloseTo(vec[i], 5);
    });
  });

  it('should search by cosine similarity', () => {
    const id1 = 'mem_1';
    const id2 = 'mem_2';
    const id3 = 'mem_3';
    
    store.store(id1, [1.0, 0.0, 0.0]);
    store.store(id2, [0.8, 0.2, 0.0]);
    store.store(id3, [0.0, 1.0, 0.0]);
    
    const query = [1.0, 0.0, 0.0];
    const results = store.search(query, 3, 0.0);
    
    expect(results).toHaveLength(3);
    expect(results[0].memory_id).toBe(id1);
    expect(results[1].memory_id).toBe(id2);
    expect(results[2].memory_id).toBe(id3);
  });

  it('should respect similarity threshold', () => {
    store.store('mem_1', [1.0, 0.0, 0.0]);
    store.store('mem_2', [0.0, 1.0, 0.0]);
    
    const query = [1.0, 0.0, 0.0];
    const results = store.search(query, 5, 0.5);
    
    expect(results).toHaveLength(1);
    expect(results[0].memory_id).toBe('mem_1');
  });

  it('should respect topK limit', () => {
    store.store('mem_1', [1.0, 0.0, 0.0]);
    store.store('mem_2', [0.9, 0.1, 0.0]);
    store.store('mem_3', [0.8, 0.2, 0.0]);
    store.store('mem_4', [0.7, 0.3, 0.0]);
    store.store('mem_5', [0.6, 0.4, 0.0]);
    
    const query = [1.0, 0.0, 0.0];
    const results = store.search(query, 2, 0.0);
    
    expect(results).toHaveLength(2);
    expect(results[0].memory_id).toBe('mem_1');
    expect(results[1].memory_id).toBe('mem_2');
  });

  it('should delete an embedding', () => {
    const id = 'mem_1';
    store.store(id, [0.1, 0.2, 0.3]);
    store.delete(id);
    
    const retrieved = store.getEmbedding(id);
    expect(retrieved).toBeNull();
  });

  it('should return correct count', () => {
    store.store('mem_1', [1.0, 0.0, 0.0]);
    store.store('mem_2', [0.9, 0.1, 0.0]);
    store.store('mem_3', [0.8, 0.2, 0.0]);
    
    expect(store.count()).toBe(3);
  });

  describe('cosineSimilarity', () => {
    it('should compute correctly for identical vectors', () => {
      const a = [1, 2, 3];
      const b = [1, 2, 3];
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
    });

    it('should compute correctly for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
    });

    it('should compute correctly for opposite vectors', () => {
      const a = [1, 1, 1];
      const b = [-1, -1, -1];
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
    });
  });
});
