import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../src/storage/database.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import { VectorStore } from '../src/storage/vector-store.js';
import { 
  clampEmotionalWeight, 
  classifyEmotionalWeight, 
  getEmotionalDecayMultiplier 
} from '../src/core/emotional.js';
import { extractMemories } from '../src/core/extraction.js';
import { EngramAgent } from '../src/agent.js';
import type { LLMProvider, EmbeddingProvider } from '../src/providers/interface.js';
import type { Message, ChatOptions } from '../src/core/types.js';

// --- Mock Providers ---

class MockLLMProvider implements LLMProvider {
  public readonly name = 'MockLLM';
  public cannedResponses: string[] = [];
  public cannedJson: any[] = [];
  public recordedMessages: Message[][] = [];

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    this.recordedMessages.push(messages);
    return this.cannedResponses.shift() || 'Default assistant reply.';
  }

  async chatJSON<T>(messages: Message[], schema: Record<string, unknown>, options?: ChatOptions): Promise<T> {
    this.recordedMessages.push(messages);
    if (this.cannedJson.length > 0) {
      return this.cannedJson.shift() as T;
    }
    return { memories: [] } as T;
  }
}

class MockEmbeddingProvider implements EmbeddingProvider {
  public readonly name = 'MockEmbedder';
  public readonly dimensions = 3;
  private vectorMap: Map<string, number[]> = new Map();

  // Helper to register deterministic embeddings for test phrases
  public register(textSubstr: string, vec: number[]) {
    this.vectorMap.set(textSubstr.toLowerCase(), vec);
  }

  async embed(text: string): Promise<number[]> {
    const lower = text.toLowerCase();
    for (const [key, vec] of this.vectorMap.entries()) {
      if (lower.includes(key)) return vec;
    }
    // Simple deterministic fallback vector based on string hash
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash << 5) - hash + text.charCodeAt(i);
    return [Math.sin(hash), Math.cos(hash), Math.sin(hash * 2)];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

describe('Emotional Scoring Module', () => {
  it('clamps emotional weights properly between 0.0 and 1.0', () => {
    expect(clampEmotionalWeight(-0.5)).toBe(0.0);
    expect(clampEmotionalWeight(1.5)).toBe(1.0);
    expect(clampEmotionalWeight(0.75)).toBe(0.75);
    expect(clampEmotionalWeight(NaN)).toBe(0.0);
  });

  it('calculates emotional decay multipliers accurately', () => {
    expect(getEmotionalDecayMultiplier(0.0)).toBe(1.0);
    expect(getEmotionalDecayMultiplier(0.5)).toBe(1.5);
    expect(getEmotionalDecayMultiplier(1.0)).toBe(2.0);
  });

  it('classifies emotional intensity into correct buckets', () => {
    expect(classifyEmotionalWeight(0.05).intensity).toBe('neutral');
    expect(classifyEmotionalWeight(0.35).intensity).toBe('mild');
    expect(classifyEmotionalWeight(0.65).intensity).toBe('significant');
    expect(classifyEmotionalWeight(0.95).intensity).toBe('critical');
  });
});

describe('Memory Extraction Pipeline', () => {
  let mockLLM: MockLLMProvider;

  beforeEach(() => {
    mockLLM = new MockLLMProvider();
  });

  it('fast-paths trivial conversational inputs without calling LLM', async () => {
    const trivialInputs = ['thanks', 'ok', 'okay', 'cool', 'sounds good', 'yes', 'no'];
    for (const input of trivialInputs) {
      const result = await extractMemories(input, 'You are welcome!', mockLLM);
      expect(result).toEqual([]);
      expect(mockLLM.recordedMessages.length).toBe(0);
    }
  });

  it('extracts structured memories from substantive conversation turns', async () => {
    mockLLM.cannedJson.push({
      memories: [
        {
          content: 'User relocated from Berlin to Lisbon',
          type: 'episodic',
          importance: 0.85,
          emotional_weight: 0.6,
          entities: [
            { name: 'Berlin', type: 'location', relation: 'moved_from' },
            { name: 'Lisbon', type: 'location', relation: 'moved_to' }
          ],
          reasoning: 'Explicit location change milestone'
        },
        {
          content: 'User works at Stripe',
          type: 'semantic',
          importance: 0.8,
          emotional_weight: 0.2,
          entities: [
            { name: 'Stripe', type: 'organization', relation: 'works_at' }
          ],
          reasoning: 'Stable employment fact'
        }
      ]
    });

    const extracted = await extractMemories(
      'I just moved from Berlin to Lisbon for my new engineering job at Stripe!',
      'Congratulations on the move and the new role at Stripe!',
      mockLLM
    );

    expect(extracted).toHaveLength(2);
    expect(extracted[0].content).toBe('User relocated from Berlin to Lisbon');
    expect(extracted[0].type).toBe('episodic');
    expect(extracted[0].importance).toBe(0.85);
    expect(extracted[0].entities).toHaveLength(2);

    expect(extracted[1].content).toBe('User works at Stripe');
    expect(extracted[1].type).toBe('semantic');
  });

  it('handles empty or malformed LLM responses without throwing', async () => {
    mockLLM.cannedJson.push(null);
    const result1 = await extractMemories('Some text', 'Reply', mockLLM);
    expect(result1).toEqual([]);

    mockLLM.cannedJson.push({ unexpected: 'shape' });
    const result2 = await extractMemories('Some other text', 'Reply', mockLLM);
    expect(result2).toEqual([]);
  });
});

describe('EngramAgent Conversational Loop & Deduplication', () => {
  let db: any;
  let mockLLM: MockLLMProvider;
  let mockEmbedder: MockEmbeddingProvider;
  let agent: EngramAgent;

  beforeEach(() => {
    db = initDatabase(':memory:');
    mockLLM = new MockLLMProvider();
    mockEmbedder = new MockEmbeddingProvider();
    agent = new EngramAgent(db, mockLLM, mockEmbedder);
  });

  it('executes chat turn, saves extracted memory, and recalls in subsequent turn', async () => {
    // Vector for peanut allergy
    const allergyVec = [1.0, 0.0, 0.0];
    mockEmbedder.register('peanut', allergyVec);
    mockEmbedder.register('dinner', [0.9, 0.1, 0.0]); // Similar enough to dinner query

    // Turn 1: User reveals peanut allergy
    mockLLM.cannedResponses.push('Understood, I will remember your peanut allergy.');
    mockLLM.cannedJson.push({
      memories: [
        {
          content: 'User is severely allergic to peanuts',
          type: 'semantic',
          importance: 0.95,
          emotional_weight: 0.8,
          entities: [{ name: 'Peanuts', type: 'allergen', relation: 'allergic_to' }],
          reasoning: 'Critical medical health allergy'
        }
      ]
    });

    const turn1 = await agent.chat('Please keep in mind that I am severely allergic to peanuts.');
    expect(turn1.response).toBe('Understood, I will remember your peanut allergy.');
    expect(turn1.extractedMemories).toHaveLength(1);
    expect(turn1.extractedMemories[0].content).toBe('User is severely allergic to peanuts');

    // Turn 2: User asks dinner recommendation
    mockLLM.cannedResponses.push('Since you are allergic to peanuts, I suggest a fresh Italian pasta dish.');
    mockLLM.cannedJson.push({ memories: [] });

    const turn2 = await agent.chat('What should I make for dinner tonight?');
    expect(turn2.recalledMemories).toHaveLength(1);
    expect(turn2.recalledMemories[0].content).toBe('User is severely allergic to peanuts');

    // Verify system prompt received injected memory in turn 2
    const lastPrompt = mockLLM.recordedMessages[mockLLM.recordedMessages.length - 2]; // The chat call
    const systemMessage = lastPrompt.find(m => m.role === 'system');
    expect(systemMessage?.content).toContain('User is severely allergic to peanuts');
  });

  it('deduplicates semantically identical facts by reinforcing existing memory instead of duplicating', async () => {
    const identicalVec = [0.8, 0.6, 0.0];
    mockEmbedder.register('lisbon', identicalVec);

    // First mention
    mockLLM.cannedResponses.push('Lisbon is a wonderful city!');
    mockLLM.cannedJson.push({
      memories: [
        {
          content: 'User lives in Lisbon',
          type: 'semantic',
          importance: 0.8,
          emotional_weight: 0.2,
          entities: [{ name: 'Lisbon', type: 'location', relation: 'lives_in' }],
          reasoning: 'Location fact'
        }
      ]
    });

    await agent.chat('I live in Lisbon.');
    let stats = agent.getStats();
    expect(stats.active).toBe(1);

    const firstMem = agent.getActiveMemories()[0];
    expect(firstMem.recall_count).toBe(0);

    // Second mention (duplicate)
    mockLLM.cannedResponses.push('Yes, Lisbon is great.');
    mockLLM.cannedJson.push({
      memories: [
        {
          content: 'User lives in Lisbon',
          type: 'semantic',
          importance: 0.8,
          emotional_weight: 0.2,
          entities: [{ name: 'Lisbon', type: 'location', relation: 'lives_in' }],
          reasoning: 'Location fact'
        }
      ]
    });

    await agent.chat('As I mentioned, I live in Lisbon.');
    stats = agent.getStats();
    // Memory count must still be 1 (NOT 2)
    expect(stats.active).toBe(1);

    const reinforcedMem = agent.getActiveMemories()[0];
    // Recall count should have been incremented to reinforce the memory
    expect(reinforcedMem.recall_count).toBeGreaterThan(0);
  });
});
