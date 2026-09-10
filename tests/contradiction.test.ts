import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../src/storage/database.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import { VectorStore } from '../src/storage/vector-store.js';
import { detectContradictions, resolveContradictions } from '../src/processes/contradiction.js';
import { EngramAgent } from '../src/agent.js';
import { SimulatedTimeProvider, DEFAULT_CONFIG } from '../src/core/types.js';
import type { Memory, Message, ChatOptions } from '../src/core/types.js';
import type { LLMProvider, EmbeddingProvider } from '../src/providers/interface.js';

class MockLLM implements LLMProvider {
  public readonly name = 'MockLLM';
  public cannedJson: any[] = [];
  public cannedText = 'Default reply';
  public recordedMessages: Message[][] = [];

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    this.recordedMessages.push(messages);
    return this.cannedText;
  }

  async chatJSON<T>(messages: Message[], schema: Record<string, unknown>, options?: ChatOptions): Promise<T> {
    this.recordedMessages.push(messages);
    if (this.cannedJson.length > 0) {
      return this.cannedJson.shift() as T;
    }
    return { evaluations: [] } as T;
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

describe('NLI Contradiction Detection Engine', () => {
  let mockLlm: MockLLM;

  beforeEach(() => {
    mockLlm = new MockLLM();
  });

  it('detects when an incoming fact directly contradicts a prior fact', async () => {
    const oldMem = createMem('mem_berlin', 'User lives in Berlin');
    const newDraft = {
      content: 'User relocated to Lisbon',
      type: 'semantic' as const,
      importance: 0.8,
      emotional_weight: 0.5,
      entities: [],
      reasoning: 'Moved city'
    };

    mockLlm.cannedJson.push({
      evaluations: [
        {
          old_memory_id: 'mem_berlin',
          classification: 'CONTRADICTION',
          confidence: 0.95,
          reasoning: 'Primary residence conflict: a person resides in one primary city'
        }
      ]
    });

    const evals = await detectContradictions(newDraft, [oldMem], mockLlm);
    expect(evals).toHaveLength(1);
    expect(evals[0].classification).toBe('CONTRADICTION');
    expect(evals[0].confidence).toBe(0.95);
    expect(evals[0].old_memory_id).toBe('mem_berlin');
  });

  it('classifies compatible refinements as ENTAILMENT without triggering contradiction', async () => {
    const oldMem = createMem('mem_google', 'User works at Google');
    const newDraft = {
      content: 'User works on the Google Maps team as a tech lead',
      type: 'semantic' as const,
      importance: 0.8,
      emotional_weight: 0.2,
      entities: [],
      reasoning: 'Team detail'
    };

    mockLlm.cannedJson.push({
      evaluations: [
        {
          old_memory_id: 'mem_google',
          classification: 'ENTAILMENT',
          confidence: 0.90,
          reasoning: 'Refinement: Adds team and role specificity to existing employer fact'
        }
      ]
    });

    const evals = await detectContradictions(newDraft, [oldMem], mockLlm);
    expect(evals).toHaveLength(1);
    expect(evals[0].classification).toBe('ENTAILMENT');
  });

  it('handles empty candidate lists gracefully without LLM calls', async () => {
    const newDraft = {
      content: 'User likes coffee',
      type: 'semantic' as const,
      importance: 0.5,
      emotional_weight: 0.1,
      entities: [],
      reasoning: 'Coffee preference'
    };

    const evals = await detectContradictions(newDraft, [], mockLlm);
    expect(evals).toEqual([]);
    expect(mockLlm.recordedMessages.length).toBe(0);
  });
});

describe('Contradiction Resolution & Audit Logging', () => {
  let db: any;
  let memoryStore: MemoryStore;
  let vectorStore: VectorStore;

  beforeEach(() => {
    db = initDatabase(':memory:');
    memoryStore = new MemoryStore(db);
    vectorStore = new VectorStore(db);
  });

  it('supersedes outdated memory and transfers recall knowledge', () => {
    const oldMem = createMem('old_1', 'User lives in Berlin', { recall_count: 4 });
    memoryStore.create(oldMem);

    const newMem = createMem('new_1', 'User moved to Lisbon', { recall_count: 0 });
    memoryStore.create(newMem);

    const evals = [
      {
        old_memory_id: 'old_1',
        classification: 'CONTRADICTION' as const,
        confidence: 0.92,
        reasoning: 'Location conflict'
      }
    ];

    const records = resolveContradictions(newMem, evals, memoryStore, db, '2026-09-08T12:00:00.000Z');

    expect(records).toHaveLength(1);
    expect(records[0].old_memory_id).toBe('old_1');
    expect(records[0].new_memory_id).toBe('new_1');

    // Verify old memory status changed to superseded
    const updatedOld = memoryStore.getById('old_1');
    expect(updatedOld?.status).toBe('superseded');
    expect(updatedOld?.superseded_by).toBe('new_1');

    // Verify knowledge transfer: recall_count transferred from old to new
    expect(newMem.recall_count).toBeGreaterThanOrEqual(5);

    // Verify audit log
    const auditLogs = memoryStore.getContradictions();
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].old_content).toBe('User lives in Berlin');
    expect(auditLogs[0].new_content).toBe('User moved to Lisbon');

    // Verify active memory query excludes superseded fact
    const active = memoryStore.getActiveByUser('default_user');
    expect(active.map(m => m.id)).not.toContain('old_1');
    expect(active.map(m => m.id)).toContain('new_1');
  });
});

describe('EngramAgent End-to-End Contradiction Lifecycle', () => {
  it('automatically resolves contradiction during conversation', async () => {
    const db = initDatabase(':memory:');
    const mockLlm = new MockLLM();
    const mockEmbedder = new MockEmbedder();
    const time = new SimulatedTimeProvider(new Date('2026-09-08T00:00:00.000Z'));
    const agent = new EngramAgent(db, mockLlm, mockEmbedder, DEFAULT_CONFIG, time);

    mockEmbedder.register('berlin', [1.0, 0.0, 0.0]);
    mockEmbedder.register('lisbon', [0.6, 0.8, 0.0]); // Vector similarity ~0.60 (above contradiction threshold 0.25, below dedup 0.92)

    // Turn 1: User says they live in Berlin
    mockLlm.cannedText = 'Noted that you live in Berlin!';
    mockLlm.cannedJson.push({
      memories: [{
        content: 'User lives in Berlin',
        type: 'semantic',
        importance: 0.8,
        emotional_weight: 0.2,
        entities: [{ name: 'Berlin', type: 'location', relation: 'lives_in' }],
        reasoning: 'Location fact'
      }]
    });

    await agent.chat('I live in Berlin.');
    expect(agent.getActiveMemories()).toHaveLength(1);
    expect(agent.getActiveMemories()[0].content).toBe('User lives in Berlin');

    // Turn 2: User says they moved to Lisbon
    time.advance(24 * 7); // 1 week later
    mockLlm.cannedText = 'Congrats on moving to Lisbon!';
    // 1st chatJSON call: extraction
    mockLlm.cannedJson.push({
      memories: [{
        content: 'User relocated to Lisbon',
        type: 'semantic',
        importance: 0.85,
        emotional_weight: 0.6,
        entities: [{ name: 'Lisbon', type: 'location', relation: 'moved_to' }],
        reasoning: 'New location'
      }]
    });
    // 2nd chatJSON call: contradiction detection
    mockLlm.cannedJson.push({
      evaluations: [{
        old_memory_id: agent.getActiveMemories()[0].id,
        classification: 'CONTRADICTION',
        confidence: 0.96,
        reasoning: 'Relocation supersedes previous city residence'
      }]
    });

    await agent.chat('I just moved to Lisbon for good!');

    // Only Lisbon should remain active
    const activeMemories = agent.getActiveMemories();
    expect(activeMemories).toHaveLength(1);
    expect(activeMemories[0].content).toBe('User relocated to Lisbon');

    // Audit log should contain the contradiction record
    const contradictions = agent.getContradictions();
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0].old_content).toBe('User lives in Berlin');
    expect(contradictions[0].new_content).toBe('User relocated to Lisbon');
  });
});
