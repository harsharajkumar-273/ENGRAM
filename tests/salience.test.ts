import { describe, it, expect, beforeEach } from 'vitest';
import type { Memory } from '../src/core/types.js';
import { 
  computeSalience, 
  getAdaptiveHalfLife, 
  isMemoryDormant, 
  hoursUntilDormant,
  diffHours 
} from '../src/core/salience.js';
import { runDecaySweep } from '../src/processes/decay-sweep.js';
import { initDatabase } from '../src/storage/database.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import { VectorStore } from '../src/storage/vector-store.js';
import { SimulatedTimeProvider, DEFAULT_CONFIG } from '../src/core/types.js';

function createMemory(overrides: Partial<Memory> = {}): Memory {
  const baseTime = '2026-09-08T00:00:00.000Z';
  return {
    id: 'test_mem_1',
    type: 'episodic',
    status: 'active',
    content: 'Test memory content',
    source_turn_id: 'turn_1',
    importance: 0.8,
    emotional_weight: 0.0,
    recall_count: 0,
    base_half_life_hours: 72,
    strengthening_factor: 0.5,
    created_at: baseTime,
    last_recalled_at: baseTime,
    entities: [],
    superseded_by: null,
    consolidated_from: [],
    user_id: 'user_1',
    session_id: 'session_1',
    ...overrides
  };
}

describe('Salience & Ebbinghaus Decay Math', () => {
  it('computes adaptive half-life growth with spaced repetition', () => {
    const mem0 = createMemory({ recall_count: 0, base_half_life_hours: 72, strengthening_factor: 0.5 });
    expect(getAdaptiveHalfLife(mem0)).toBe(72);

    const mem1 = createMemory({ recall_count: 1, base_half_life_hours: 72, strengthening_factor: 0.5 });
    expect(getAdaptiveHalfLife(mem1)).toBe(108); // 72 * 1.5

    const mem3 = createMemory({ recall_count: 3, base_half_life_hours: 72, strengthening_factor: 0.5 });
    expect(getAdaptiveHalfLife(mem3)).toBeCloseTo(243, 2); // 72 * 1.5^3

    const mem5 = createMemory({ recall_count: 5, base_half_life_hours: 72, strengthening_factor: 0.5 });
    expect(getAdaptiveHalfLife(mem5)).toBeCloseTo(546.75, 2); // 72 * 1.5^5

    const mem10 = createMemory({ recall_count: 10, base_half_life_hours: 72, strengthening_factor: 0.5 });
    expect(getAdaptiveHalfLife(mem10)).toBeCloseTo(4151.88, 1); // 72 * 1.5^10 ≈ 4151.88h (~173 days)
  });

  it('decays by exactly 50% after one half-life', () => {
    const mem = createMemory({ importance: 0.8, recall_count: 0, emotional_weight: 0.0, base_half_life_hours: 72 });
    const startTime = new Date(mem.last_recalled_at);

    // At dt = 0
    const initialSalience = computeSalience(mem, startTime);
    expect(initialSalience).toBeCloseTo(0.8, 4);

    // At dt = 72h (1 half-life)
    const timeAfter72h = new Date(startTime.getTime() + 72 * 60 * 60 * 1000);
    const halfSalience = computeSalience(mem, timeAfter72h);
    expect(halfSalience).toBeCloseTo(initialSalience / 2, 4);

    // At dt = 144h (2 half-lives)
    const timeAfter144h = new Date(startTime.getTime() + 144 * 60 * 60 * 1000);
    const quarterSalience = computeSalience(mem, timeAfter144h);
    expect(quarterSalience).toBeCloseTo(initialSalience / 4, 4);
  });

  it('proves spaced repetition preserves memories much longer than unreinforced ones', () => {
    const startTime = new Date('2026-09-08T00:00:00.000Z');
    const elapsedHours = 150; // Over 6 days later
    const futureTime = new Date(startTime.getTime() + elapsedHours * 60 * 60 * 1000);

    // Memory A: Mentioned once, never recalled (n = 0)
    const unreinforced = createMemory({
      importance: 0.8,
      recall_count: 0,
      base_half_life_hours: 72,
      created_at: startTime.toISOString(),
      last_recalled_at: startTime.toISOString()
    });

    // Memory B: Reinforced 5 times (n = 5)
    const reinforced = createMemory({
      importance: 0.8,
      recall_count: 5,
      base_half_life_hours: 72,
      created_at: startTime.toISOString(),
      last_recalled_at: startTime.toISOString()
    });

    const salienceUnreinforced = computeSalience(unreinforced, futureTime);
    const salienceReinforced = computeSalience(reinforced, futureTime);

    // Unreinforced memory has decayed past two half-lives (< 0.20)
    expect(salienceUnreinforced).toBeLessThan(0.20);

    // Reinforced memory half-life is ~547h, so after 150h it still retains high salience
    expect(salienceReinforced).toBeGreaterThan(1.5);
    expect(salienceReinforced / salienceUnreinforced).toBeGreaterThan(8);
  });

  it('applies emotional retention multiplier so emotional events decay slower', () => {
    const startTime = new Date('2026-09-08T00:00:00.000Z');
    const time72hLater = new Date(startTime.getTime() + 72 * 60 * 60 * 1000);

    const neutralMem = createMemory({
      importance: 0.8,
      emotional_weight: 0.0,
      base_half_life_hours: 72,
      last_recalled_at: startTime.toISOString()
    });

    const emotionalMem = createMemory({
      importance: 0.8,
      emotional_weight: 0.9,
      base_half_life_hours: 72,
      last_recalled_at: startTime.toISOString()
    });

    const neutralSalience = computeSalience(neutralMem, time72hLater);
    const emotionalSalience = computeSalience(emotionalMem, time72hLater);

    expect(emotionalSalience).toBeCloseTo(neutralSalience * 1.9, 2);
  });

  it('accurately predicts hours until dormancy', () => {
    const startTime = new Date('2026-09-08T00:00:00.000Z');
    const mem = createMemory({
      importance: 0.8,
      recall_count: 0,
      base_half_life_hours: 72,
      last_recalled_at: startTime.toISOString()
    });

    const hours = hoursUntilDormant(mem, startTime, 0.01);
    expect(hours).toBeGreaterThan(0);

    // Advance to exactly that predicted time
    const dormancyTime = new Date(startTime.getTime() + hours * 60 * 60 * 1000);
    const salienceAtDormancy = computeSalience(mem, dormancyTime);

    // Salience should be right at the dormancy threshold (0.01)
    expect(salienceAtDormancy).toBeCloseTo(0.01, 3);
  });
});

describe('Decay Sweep Background Process', () => {
  let db: any;
  let memoryStore: MemoryStore;
  let vectorStore: VectorStore;
  let time: SimulatedTimeProvider;

  beforeEach(() => {
    db = initDatabase(':memory:');
    memoryStore = new MemoryStore(db);
    vectorStore = new VectorStore(db);
    time = new SimulatedTimeProvider(new Date('2026-09-08T00:00:00.000Z'));
  });

  it('marks faded memories as dormant during decay sweep', () => {
    const nowIso = time.now().toISOString();

    // Memory 1: Low importance, fast decaying
    const trivialMem = createMemory({
      id: 'trivial_1',
      importance: 0.1,
      recall_count: 0,
      base_half_life_hours: 24,
      created_at: nowIso,
      last_recalled_at: nowIso
    });

    // Memory 2: High importance, slow decaying
    const criticalMem = createMemory({
      id: 'critical_1',
      importance: 0.95,
      recall_count: 2,
      base_half_life_hours: 720,
      created_at: nowIso,
      last_recalled_at: nowIso
    });

    memoryStore.create(trivialMem);
    vectorStore.store(trivialMem.id, [1, 0, 0]);

    memoryStore.create(criticalMem);
    vectorStore.store(criticalMem.id, [0, 1, 0]);

    // Initial sweep: both are fresh and active
    const sweep1 = runDecaySweep(memoryStore, vectorStore, time.now(), DEFAULT_CONFIG);
    expect(sweep1.markedDormantCount).toBe(0);
    expect(sweep1.activeRemainingCount).toBe(2);

    // Fast-forward time by 120 hours (5 days)
    time.advance(120);

    const sweep2 = runDecaySweep(memoryStore, vectorStore, time.now(), DEFAULT_CONFIG);
    // Trivial memory should have faded below 0.01
    expect(sweep2.markedDormantCount).toBe(1);
    expect(sweep2.activeRemainingCount).toBe(1);

    const updatedTrivial = memoryStore.getById('trivial_1');
    expect(updatedTrivial?.status).toBe('dormant');

    const updatedCritical = memoryStore.getById('critical_1');
    expect(updatedCritical?.status).toBe('active');
  });

  it('purges dormant memories after grace period expires', () => {
    const nowIso = time.now().toISOString();
    const mem = createMemory({
      id: 'purge_test',
      importance: 0.1,
      base_half_life_hours: 10,
      created_at: nowIso,
      last_recalled_at: nowIso
    });

    memoryStore.create(mem);
    vectorStore.store(mem.id, [1, 0, 0]);

    // Fast-forward to make it dormant
    time.advance(100);
    runDecaySweep(memoryStore, vectorStore, time.now(), DEFAULT_CONFIG);
    expect(memoryStore.getById('purge_test')?.status).toBe('dormant');

    // Fast-forward another 170 hours (> 168h grace period)
    time.advance(170);
    const sweep = runDecaySweep(memoryStore, vectorStore, time.now(), DEFAULT_CONFIG, 168);

    expect(sweep.purgedCount).toBe(1);
    expect(memoryStore.getById('purge_test')).toBeNull();
    expect(vectorStore.getEmbedding('purge_test')).toBeNull();
  });
});
