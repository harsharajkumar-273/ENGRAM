import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../src/storage/database.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import { Memory } from '../src/core/types.js';
import { v4 as uuidv4 } from 'uuid';

function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: uuidv4(),
    type: 'semantic',
    status: 'active',
    content: 'Test memory',
    source_turn_id: 'test_turn',
    importance: 0.5,
    emotional_weight: 0.0,
    recall_count: 0,
    base_half_life_hours: 720,
    strengthening_factor: 0.5,
    created_at: new Date().toISOString(),
    last_recalled_at: new Date().toISOString(),
    entities: [],
    superseded_by: null,
    consolidated_from: [],
    user_id: 'user_1',
    session_id: 'session_1',
    ...overrides,
  };
}

describe('MemoryStore', () => {
  let db: any;
  let store: MemoryStore;

  beforeEach(() => {
    db = initDatabase(':memory:');
    store = new MemoryStore(db);
  });

  it('should create and retrieve a memory', () => {
    const memory = createTestMemory();
    store.create(memory);
    const retrieved = store.getById(memory.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(memory.id);
    expect(retrieved?.content).toBe(memory.content);
  });

  it('should list active memories for a user', () => {
    const mem1 = createTestMemory({ status: 'active' });
    const mem2 = createTestMemory({ status: 'active' });
    const mem3 = createTestMemory({ status: 'dormant' });
    
    store.create(mem1);
    store.create(mem2);
    store.create(mem3);

    const active = store.getActiveByUser('user_1');
    expect(active).toHaveLength(2);
    expect(active.map(m => m.id)).toContain(mem1.id);
    expect(active.map(m => m.id)).toContain(mem2.id);
  });

  it('should update recall stats', () => {
    const memory = createTestMemory();
    store.create(memory);
    
    const now = new Date().toISOString();
    store.updateRecallStats(memory.id, now);
    
    const retrieved = store.getById(memory.id);
    expect(retrieved?.recall_count).toBe(1);
    expect(retrieved?.last_recalled_at).toBe(now);
  });

  it('should update memory status', () => {
    const memory = createTestMemory({ status: 'active' });
    store.create(memory);
    
    store.updateStatus(memory.id, 'dormant');
    
    const retrieved = store.getById(memory.id);
    expect(retrieved?.status).toBe('dormant');
  });

  it('should delete a memory', () => {
    const memory = createTestMemory();
    store.create(memory);
    
    store.deleteMemory(memory.id);
    
    const retrieved = store.getById(memory.id);
    expect(retrieved).toBeNull();
  });

  it('should count memories by status', () => {
    store.create(createTestMemory({ status: 'active' }));
    store.create(createTestMemory({ status: 'active' }));
    store.create(createTestMemory({ status: 'dormant' }));
    store.create(createTestMemory({ status: 'superseded' }));
    
    const stats = store.countByUser('user_1');
    expect(stats.total).toBe(4);
    expect(stats.active).toBe(2);
    expect(stats.dormant).toBe(1);
    expect(stats.superseded).toBe(1);
    expect(stats.consolidated).toBe(0);
  });

  it('should handle non-existent memory gracefully', () => {
    const retrieved = store.getById('non_existent_id');
    expect(retrieved).toBeNull();
  });
});
