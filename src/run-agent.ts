#!/usr/bin/env node
// ============================================================================
// Engram Standalone Autonomous Agent CLI Runner
// Usage: npm run agent -- "your goal here"
// ============================================================================

import dotenv from 'dotenv';
import { initDatabase } from './storage/database.js';
import { MemoryStore } from './storage/memory-store.js';
import { VectorStore } from './storage/vector-store.js';
import { GraphStore } from './storage/graph-store.js';
import { GeminiLLMProvider, GeminiEmbeddingProvider } from './providers/gemini.js';
import type { LLMProvider, EmbeddingProvider } from './providers/interface.js';
import { AutonomousAgent } from './agent/autonomous.js';
import { createDefaultToolRegistry } from './agent/tools.js';
import { formatTerminalStep, formatTraceSummary } from './agent/telemetry.js';
import type { Message } from './core/types.js';

dotenv.config();

// Fallback provider if GEMINI_API_KEY is not set
class FallbackAutonomousLLM implements LLMProvider {
  readonly name = 'fallback-react-llm';
  private step = 0;

  async chat(messages: Message[]): Promise<string> {
    return 'Fallback completed.';
  }

  async chatJSON<T>(messages: Message[], schema: Record<string, unknown>): Promise<T> {
    this.step++;
    const userMsg = messages[messages.length - 1]?.content || '';

    // Step 1: Calculate
    if (this.step === 1) {
      return {
        thought: 'I need to calculate the compound interest using the formula A = P * (1 + r/n)^(n*t). Here P = 10000, r = 0.07, n = 12, t = 5.',
        action: {
          tool: 'calculator',
          parameters: {
            expression: '10000 * Math.pow(1 + 0.07 / 12, 12 * 5)'
          }
        },
        isFinalAnswer: false,
        finalAnswer: null
      } as T;
    }

    // Step 2: Write result to file
    if (this.step === 2) {
      const observation = userMsg;
      return {
        thought: `The calculation result is ${observation}. Now I will save this investment summary to scratch/investment.txt as requested.`,
        action: {
          tool: 'file_write',
          parameters: {
            path: 'scratch/investment.txt',
            content: `Investment Growth Summary:\n- Principal: $10,000.00\n- Annual Rate: 7.0%\n- Compounding: Monthly (12/yr)\n- Duration: 5 Years\n- Final Future Value: $14,176.25\n- Total Interest Earned: $4,176.25\n`
          }
        },
        isFinalAnswer: false,
        finalAnswer: null
      } as T;
    }

    // Step 3: Finish
    return {
      thought: 'Calculation completed and summary written to scratch/investment.txt. The goal is fully achieved.',
      action: null,
      isFinalAnswer: true,
      finalAnswer: 'The final future value of $10,000 compounded monthly at 7% for 5 years is $14,176.25 (total interest earned: $4,176.25). The summary has been written to scratch/investment.txt.'
    } as T;
  }
}

async function main() {
  const goalArgs = process.argv.slice(2).join(' ').trim();
  const goal = goalArgs || 'Calculate compound interest on $10,000 at 7% compounded monthly for 5 years and save summary to scratch/investment.txt';

  const dbPath = process.env.ENGRAM_DB_PATH || process.env.DB_PATH || 'engram.db';
  const apiKey = process.env.GEMINI_API_KEY || '';

  const db = initDatabase(dbPath);
  const memoryStore = new MemoryStore(db);
  const vectorStore = new VectorStore(db);
  const graphStore = new GraphStore(db);

  const llm: LLMProvider = apiKey.trim() ? new GeminiLLMProvider(apiKey) : new FallbackAutonomousLLM();
  const embedder: EmbeddingProvider | null = apiKey.trim() ? new GeminiEmbeddingProvider(apiKey) : null;
  const tools = createDefaultToolRegistry();

  console.log(`\x1b[35m====================================================\x1b[0m`);
  console.log(`\x1b[35m   🧠 Engram Autonomous ReAct Agent Running...       \x1b[0m`);
  console.log(`\x1b[35m====================================================\x1b[0m\n`);
  console.log(`\x1b[90mGoal:\x1b[0m "${goal}"`);
  console.log(`\x1b[90mLLM Provider: ${llm.name} | Active Tools: ${tools.getAll().map(t => t.name).join(', ')}\x1b[0m\n`);

  const agent = new AutonomousAgent(llm, tools, memoryStore, vectorStore, graphStore, embedder, {
    maxSteps: 10,
    onStep: (step) => {
      console.log(formatTerminalStep(step));
    }
  });

  const result = await agent.executeGoal(goal);

  if (result.status === 'completed') {
    console.log(`\x1b[32m🎯 [Final Answer]\x1b[0m\n${result.finalAnswer}\n`);
    console.log(`\x1b[90m✔ Execution completed in ${result.trace.totalLatencyMs}ms across ${result.trace.steps.length} steps (${result.trace.totalToolCalls} tool calls)\x1b[0m`);
  } else {
    console.log(`\x1b[31m⚠️ Execution stopped: ${result.status} (${result.trace.circuitBreakerReason || 'Incomplete'})\x1b[0m`);
  }

  db.close();
}

main().catch(err => {
  console.error('Agent execution failed:', err);
  process.exit(1);
});
