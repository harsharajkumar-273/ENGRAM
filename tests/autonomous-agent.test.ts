import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutonomousAgent } from '../src/agent/autonomous.js';
import { ToolRegistry, calculatorTool, fileWriteTool, fileReadTool } from '../src/agent/tools.js';
import { initDatabase } from '../src/storage/database.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import type { LLMProvider } from '../src/providers/interface.js';
import type { Message } from '../src/core/types.js';

class MockSequenceLLM implements LLMProvider {
  readonly name = 'mock-sequence-llm';
  private responses: any[];
  private index = 0;

  constructor(responses: any[]) {
    this.responses = responses;
  }

  async chat(messages: Message[]): Promise<string> {
    const res = this.responses[this.index] || this.responses[this.responses.length - 1];
    this.index++;
    return typeof res === 'string' ? res : JSON.stringify(res);
  }

  async chatJSON<T>(messages: Message[], schema: Record<string, unknown>): Promise<T> {
    const res = this.responses[this.index] || this.responses[this.responses.length - 1];
    this.index++;
    return res as T;
  }
}

import * as fs from 'fs';

describe('AutonomousAgent ReAct Execution Engine', () => {
  beforeEach(() => {
    try { fs.unlinkSync('non_existent_notes.txt'); } catch {}
    try { fs.unlinkSync('scratch_proc_test.txt'); } catch {}
  });

  afterEach(() => {
    try { fs.unlinkSync('non_existent_notes.txt'); } catch {}
    try { fs.unlinkSync('scratch_proc_test.txt'); } catch {}
  });
  it('solves single-turn goals directly without tool calls', async () => {
    const mockLLM = new MockSequenceLLM([
      {
        thought: 'This is a factual question that can be answered immediately.',
        action: null,
        isFinalAnswer: true,
        finalAnswer: 'Paris is the capital of France.'
      }
    ]);

    const tools = new ToolRegistry();
    const agent = new AutonomousAgent(mockLLM, tools);

    const result = await agent.executeGoal('What is the capital of France?');
    expect(result.status).toBe('completed');
    expect(result.finalAnswer).toBe('Paris is the capital of France.');
    expect(result.trace.steps.length).toBe(1);
    expect(result.trace.totalToolCalls).toBe(0);
  });

  it('executes multi-step tool calls to solve computational objectives', async () => {
    const mockLLM = new MockSequenceLLM([
      {
        thought: 'I need to calculate 25 * 40 first.',
        action: {
          tool: 'calculator',
          parameters: { expression: '25 * 40' }
        },
        isFinalAnswer: false,
        finalAnswer: null
      },
      {
        thought: 'The calculator returned 1000. Goal is satisfied.',
        action: null,
        isFinalAnswer: true,
        finalAnswer: 'The product of 25 and 40 is 1,000.'
      }
    ]);

    const tools = new ToolRegistry();
    tools.register(calculatorTool);

    const agent = new AutonomousAgent(mockLLM, tools);
    const result = await agent.executeGoal('Compute 25 * 40');

    expect(result.status).toBe('completed');
    expect(result.finalAnswer).toBe('The product of 25 and 40 is 1,000.');
    expect(result.trace.steps.length).toBe(2);
    expect(result.trace.totalToolCalls).toBe(1);
    expect(result.trace.steps[0].observation).toBe('1000');
  });

  it('self-heals when a tool fails by inspecting error and adjusting action', async () => {
    const mockLLM = new MockSequenceLLM([
      // 1. Attempt reading non-existent file
      {
        thought: 'I will read notes.txt to find the answer.',
        action: {
          tool: 'file_read',
          parameters: { path: 'non_existent_notes.txt' }
        },
        isFinalAnswer: false,
        finalAnswer: null
      },
      // 2. Reflect on error observation, realize file is missing, write it first
      {
        thought: 'The file does not exist. I will create it first with fallback content.',
        action: {
          tool: 'file_write',
          parameters: { path: 'non_existent_notes.txt', content: 'Backup content verified' }
        },
        isFinalAnswer: false,
        finalAnswer: null
      },
      // 3. Goal completed
      {
        thought: 'File created and verified. Finished.',
        action: null,
        isFinalAnswer: true,
        finalAnswer: 'Recovered by creating the required file.'
      }
    ]);

    const tools = new ToolRegistry();
    tools.register(fileReadTool);
    tools.register(fileWriteTool);

    const stepCallback = vi.fn();
    const agent = new AutonomousAgent(mockLLM, tools, undefined, undefined, undefined, null, {
      onStep: stepCallback
    });

    const result = await agent.executeGoal('Ensure notes are available');
    expect(result.status).toBe('completed');
    expect(result.trace.steps[0].isError).toBe(true);
    expect(result.trace.steps[0].observation).toContain('File not found');
    expect(result.trace.steps[1].isError).toBe(false);
    expect(stepCallback).toHaveBeenCalledTimes(3);
  });

  it('circuit breaker trips on consecutive tool failures', async () => {
    // LLM keeps calling an invalid tool
    const mockLLM = new MockSequenceLLM([
      {
        thought: 'Try calling broken tool.',
        action: { tool: 'calculator', parameters: { expression: 'bad syntax +++' } },
        isFinalAnswer: false,
        finalAnswer: null
      },
      {
        thought: 'Try again with bad syntax.',
        action: { tool: 'calculator', parameters: { expression: 'bad syntax +++' } },
        isFinalAnswer: false,
        finalAnswer: null
      },
      {
        thought: 'Third attempt with bad syntax.',
        action: { tool: 'calculator', parameters: { expression: 'bad syntax +++' } },
        isFinalAnswer: false,
        finalAnswer: null
      }
    ]);

    const tools = new ToolRegistry();
    tools.register(calculatorTool);

    const agent = new AutonomousAgent(mockLLM, tools, undefined, undefined, undefined, null, {
      consecutiveErrorsLimit: 3
    });

    const result = await agent.executeGoal('Evaluate malformed expression');
    expect(result.status).toBe('circuit_broken');
    expect(result.trace.circuitBreakerReason).toContain('consecutive tool failures');
  });

  it('circuit breaker stops execution when maxSteps is reached', async () => {
    // LLM loops forever calling calculator without terminating
    const infiniteLLM = new MockSequenceLLM([
      {
        thought: 'Step iteration loop.',
        action: { tool: 'calculator', parameters: { expression: '1 + 1' } },
        isFinalAnswer: false,
        finalAnswer: null
      }
    ]);

    const tools = new ToolRegistry();
    tools.register(calculatorTool);

    const agent = new AutonomousAgent(infiniteLLM, tools, undefined, undefined, undefined, null, {
      maxSteps: 3
    });

    const result = await agent.executeGoal('Run forever');
    expect(result.status).toBe('max_steps_exceeded');
    expect(result.trace.steps.length).toBe(3);
  });

  it('records a procedural memory upon completing complex multi-tool workflow', async () => {
    const db = initDatabase(':memory:');
    const memoryStore = new MemoryStore(db);

    const mockLLM = new MockSequenceLLM([
      {
        thought: 'Calculate total.',
        action: { tool: 'calculator', parameters: { expression: '50 * 2' } },
        isFinalAnswer: false,
        finalAnswer: null
      },
      {
        thought: 'Write result.',
        action: { tool: 'file_write', parameters: { path: 'scratch_proc_test.txt', content: '100' } },
        isFinalAnswer: false,
        finalAnswer: null
      },
      {
        thought: 'Workflow complete.',
        action: null,
        isFinalAnswer: true,
        finalAnswer: 'Finished calculating and writing.'
      }
    ]);

    const tools = new ToolRegistry();
    tools.register(calculatorTool);
    tools.register(fileWriteTool);

    const agent = new AutonomousAgent(mockLLM, tools, memoryStore);
    const result = await agent.executeGoal('Calculate and store', { userId: 'proc_user' });

    expect(result.status).toBe('completed');
    const memories = memoryStore.getActiveByUser('proc_user');
    const proc = memories.find(m => m.type === 'procedural');
    expect(proc).toBeDefined();
    expect(proc?.content).toContain('Learned workflow for goal "Calculate and store"');
    expect(proc?.base_half_life_hours).toBe(2160); // 90 days
  });
});
