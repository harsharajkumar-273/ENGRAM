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
import { formatTerminalStep } from './agent/telemetry.js';
import type { Message } from './core/types.js';

dotenv.config();

// Dynamic local agent reasoning engine for offline/demo/testing runs
class DynamicOfflineLLM implements LLMProvider {
  readonly name = 'engram-offline-engine';
  private step = 0;
  private goal: string;
  private lastResult = '';

  constructor(goal: string) {
    this.goal = goal;
  }

  async chat(messages: Message[]): Promise<string> {
    return `Offline response for: "${this.goal}"`;
  }

  async chatJSON<T>(messages: Message[], schema: Record<string, unknown>): Promise<T> {
    this.step++;
    const lastMsg = messages[messages.length - 1]?.content || '';

    const isMath = /calculate|compute|math|\b(\d+\s*[\+\-\*\/]\s*\d+)\b|interest|sqrt|square root/i.test(this.goal);
    const isFileWrite = /write|save|store.*in.*\.txt|output.*to|save.*summary/i.test(this.goal);
    const isFileRead = /read|check.*\.txt|inspect.*\.txt/i.test(this.goal);
    const isMemory = /memory|remember|recall/i.test(this.goal);

    // Step 1: Initial Action
    if (this.step === 1) {
      if (isMath) {
        let expr = '10000 * Math.pow(1 + 0.07 / 12, 12 * 5)';
        if (/square root of (\d+)/i.test(this.goal) || /sqrt\s*\(?(\d+)\)?/i.test(this.goal)) {
          const m = this.goal.match(/square root of (\d+)/i) || this.goal.match(/sqrt\s*\(?(\d+)\)?/i);
          const num = m ? m[1] : '144';
          if (/multiplied by (\d+)/i.test(this.goal) || /\*\s*(\d+)/.test(this.goal)) {
            const mult = this.goal.match(/multiplied by (\d+)/i) || this.goal.match(/\*\s*(\d+)/);
            expr = `Math.sqrt(${num}) * ${mult ? mult[1] : 25}`;
          } else {
            expr = `Math.sqrt(${num})`;
          }
        } else if (/(\d+)\s*([\+\-\*\/])\s*(\d+)/.test(this.goal)) {
          const m = this.goal.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)/);
          if (m) expr = `${m[1]} ${m[2]} ${m[3]}`;
        }

        return {
          thought: `I need to evaluate the mathematical calculation required by the goal: "${expr}".`,
          action: {
            tool: 'calculator',
            parameters: { expression: expr }
          },
          isFinalAnswer: false,
          finalAnswer: null
        } as T;
      }

      if (isFileRead) {
        const match = this.goal.match(/([\w\.\-\/]+\.txt)/i);
        const path = match ? match[1] : 'scratch/investment.txt';
        return {
          thought: `I will read the file "${path}" to inspect its content and fulfill the goal.`,
          action: {
            tool: 'file_read',
            parameters: { path }
          },
          isFinalAnswer: false,
          finalAnswer: null
        } as T;
      }

      if (isMemory) {
        return {
          thought: `I will search persistent cognitive memory for relevant information.`,
          action: {
            tool: 'memory_search',
            parameters: { query: this.goal }
          },
          isFinalAnswer: false,
          finalAnswer: null
        } as T;
      }

      return {
        thought: `Goal analyzed. Executing direct answer.`,
        action: null,
        isFinalAnswer: true,
        finalAnswer: `Successfully satisfied goal: "${this.goal}".`
      } as T;
    }

    // Step 2: Follow-up Action
    if (this.step === 2) {
      this.lastResult = lastMsg.replace(/^Tool.*Result:\n?/i, '').trim();

      if (isFileWrite) {
        const match = this.goal.match(/(?:to|in)\s+([\w\.\-\/]+\.txt)/i) || this.goal.match(/([\w\.\-\/]+\.txt)/i);
        const filePath = match ? match[1] : 'scratch/result.txt';
        return {
          thought: `The calculation result is ${this.lastResult}. Now I will save this summary to "${filePath}" as requested.`,
          action: {
            tool: 'file_write',
            parameters: {
              path: filePath,
              content: `Goal: ${this.goal}\nResult: ${this.lastResult}\nTimestamp: ${new Date().toISOString()}\n`
            }
          },
          isFinalAnswer: false,
          finalAnswer: null
        } as T;
      }

      return {
        thought: `Observation received: ${this.lastResult}. The goal is satisfied.`,
        action: null,
        isFinalAnswer: true,
        finalAnswer: `Observation verified: ${this.lastResult}`
      } as T;
    }

    // Step 3: Completion
    return {
      thought: `All required tools executed successfully. Emitting final verified answer.`,
      action: null,
      isFinalAnswer: true,
      finalAnswer: `Successfully accomplished goal: "${this.goal}". Result: ${this.lastResult || 'Finished'}.`
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

  const llm: LLMProvider = apiKey.trim() ? new GeminiLLMProvider(apiKey) : new DynamicOfflineLLM(goal);
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
