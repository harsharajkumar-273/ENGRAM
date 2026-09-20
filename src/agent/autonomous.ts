// ============================================================================
// Engram Autonomous ReAct Agent Loop
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import type { LLMProvider, EmbeddingProvider } from '../providers/interface.js';
import type { ToolRegistry, ToolContext } from './tools.js';
import type { MemoryStore } from '../storage/memory-store.js';
import type { VectorStore } from '../storage/vector-store.js';
import type { GraphStore } from '../storage/graph-store.js';
import type { StepTrace, AgentExecutionTrace } from './telemetry.js';
import type { Message } from '../core/types.js';

export interface AutonomousAgentConfig {
  maxSteps?: number;
  consecutiveErrorsLimit?: number;
  totalTimeoutMs?: number;
  onStep?: (step: StepTrace) => void;
}

export interface AgentExecutionResult {
  finalAnswer: string | null;
  status: 'completed' | 'failed' | 'circuit_broken' | 'max_steps_exceeded';
  trace: AgentExecutionTrace;
}

interface ReActDecision {
  thought: string;
  action: {
    tool: string;
    parameters: Record<string, any>;
  } | null;
  isFinalAnswer: boolean;
  finalAnswer: string | null;
}

const REACT_DECISION_SCHEMA = {
  type: 'object',
  properties: {
    thought: {
      type: 'string',
      description: 'Your reasoning about the current progress, past observations, and what to do next.'
    },
    action: {
      type: ['object', 'null'],
      properties: {
        tool: { type: 'string', description: 'Name of the tool to invoke' },
        parameters: { type: 'object', description: 'Arguments for the tool' }
      },
      required: ['tool', 'parameters']
    },
    isFinalAnswer: {
      type: 'boolean',
      description: 'Set to true when you have satisfied the goal and have a final answer ready.'
    },
    finalAnswer: {
      type: ['string', 'null'],
      description: 'The comprehensive final response to the user goal when isFinalAnswer is true.'
    }
  },
  required: ['thought', 'isFinalAnswer']
};

export class AutonomousAgent {
  private llm: LLMProvider;
  private tools: ToolRegistry;
  private memoryStore?: MemoryStore;
  private vectorStore?: VectorStore;
  private graphStore?: GraphStore;
  private embedder?: EmbeddingProvider | null;
  private config: Required<AutonomousAgentConfig>;

  constructor(
    llm: LLMProvider,
    tools: ToolRegistry,
    memoryStore?: MemoryStore,
    vectorStore?: VectorStore,
    graphStore?: GraphStore,
    embedder?: EmbeddingProvider | null,
    config: AutonomousAgentConfig = {}
  ) {
    this.llm = llm;
    this.tools = tools;
    this.memoryStore = memoryStore;
    this.vectorStore = vectorStore;
    this.graphStore = graphStore;
    this.embedder = embedder;
    this.config = {
      maxSteps: config.maxSteps ?? 10,
      consecutiveErrorsLimit: config.consecutiveErrorsLimit ?? 3,
      totalTimeoutMs: config.totalTimeoutMs ?? 60000,
      onStep: config.onStep ?? (() => {}),
    };
  }

  /**
   * Executes a high-level goal using the autonomous ReAct loop with circuit breakers,
   * error self-healing, and cognitive memory read/write.
   */
  public async executeGoal(
    goal: string,
    context: { userId?: string; workingDirectory?: string } = {}
  ): Promise<AgentExecutionResult> {
    const traceId = uuidv4();
    const startTime = Date.now();
    const userId = context.userId || 'default_user';
    const steps: StepTrace[] = [];
    let consecutiveErrors = 0;
    let finalAnswer: string | null = null;
    let status: AgentExecutionResult['status'] = 'max_steps_exceeded';
    let circuitBreakerReason: string | undefined;

    const toolContext: ToolContext = {
      userId,
      memoryStore: this.memoryStore,
      vectorStore: this.vectorStore,
      embedder: this.embedder,
      workingDirectory: context.workingDirectory || process.cwd(),
    };

    // 1. Pre-execution Memory Recall: Retrieve prior rules, preferences & workflows
    let memoryPriors = '';
    if (this.memoryStore) {
      const activeMemories = this.memoryStore.getActiveByUser(userId);
      const proceduralMemories = activeMemories.filter(m => m.type === 'procedural');
      const semanticMemories = activeMemories.filter(m => m.type === 'semantic').slice(0, 5);

      const relevant = [...proceduralMemories, ...semanticMemories];
      if (relevant.length > 0) {
        memoryPriors = `\n## Relevant Past Knowledge & Procedural Guidelines (from Engram Memory):\n` +
          relevant.map(m => `- [${m.type.toUpperCase()}] ${m.content}`).join('\n') + '\n';
      }
    }

    // 2. System Instructions
    const toolDocs = this.tools.getToolDocumentation();
    const systemPrompt = `You are an Autonomous AI Agent powered by the Engram Cognitive Architecture.
Your job is to accomplish the user's goal by planning, calling tools in a loop, observing results, and self-correcting on errors.

## Available Tools:
${toolDocs}
${memoryPriors}
## Execution Protocol (ReAct):
1. Think: Reason carefully about the current state, what information you have, and what you still need.
2. Act: Call a single tool with required parameters. If you have all information necessary to answer the goal, set isFinalAnswer: true and provide finalAnswer.
3. Observe: Inspect the tool output. If the tool threw an error, REFLECT on why it failed, adjust parameters, or try an alternative strategy.
4. Never repeat the exact same failing tool call without modifying its arguments.`;

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Goal to accomplish: "${goal}"` }
    ];

    const usedTools: string[] = [];

    // 3. Autonomous Execution State Machine
    for (let stepIndex = 1; stepIndex <= this.config.maxSteps; stepIndex++) {
      // Check total execution timeout
      if (Date.now() - startTime > this.config.totalTimeoutMs) {
        status = 'circuit_broken';
        circuitBreakerReason = `Execution exceeded total timeout of ${this.config.totalTimeoutMs}ms`;
        break;
      }

      const stepStart = Date.now();
      let decision: ReActDecision;

      try {
        decision = await this.llm.chatJSON<ReActDecision>(
          messages,
          REACT_DECISION_SCHEMA,
          { temperature: 0.2 }
        );
        if (!decision || typeof decision.thought !== 'string' ||
            typeof decision.isFinalAnswer !== 'boolean') {
          throw new Error('Model decision did not match the required ReAct schema');
        }
        if (decision.isFinalAnswer && typeof decision.finalAnswer !== 'string') {
          throw new Error('Final decision did not include a final answer');
        }
        if (!decision.isFinalAnswer && !decision.action) {
          throw new Error('Non-final decision did not include an action');
        }
      } catch (llmErr) {
        // Fallback or retry on JSON parse failure
        const fallbackThought = `Error parsing decision from model: ${(llmErr as Error).message}`;
        const stepTrace: StepTrace = {
          stepNumber: stepIndex,
          thought: fallbackThought,
          action: null,
          observation: 'Failed to obtain structured decision',
          isError: true,
          latencyMs: Date.now() - stepStart,
          timestamp: new Date().toISOString(),
        };
        steps.push(stepTrace);
        this.config.onStep(stepTrace);

        consecutiveErrors++;
        if (consecutiveErrors >= this.config.consecutiveErrorsLimit) {
          status = 'circuit_broken';
          circuitBreakerReason = `Model repeatedly failed to return valid JSON (${consecutiveErrors} consecutive errors)`;
          break;
        }
        messages.push({
          role: 'user',
          content: `Your previous response could not be parsed as valid JSON. Please respond with valid JSON matching the schema.`
        });
        continue;
      }

      // Check if goal is completed
      if (decision.isFinalAnswer) {
        finalAnswer = decision.finalAnswer;
        status = 'completed';

        const stepTrace: StepTrace = {
          stepNumber: stepIndex,
          thought: decision.thought,
          action: null,
          observation: 'Goal satisfied. Final answer emitted.',
          isError: false,
          latencyMs: Date.now() - stepStart,
          timestamp: new Date().toISOString(),
        };
        steps.push(stepTrace);
        this.config.onStep(stepTrace);
        break;
      }

      // Execute Action
      const action = decision.action;
      if (!action) {
        throw new Error('Validated non-final decision unexpectedly lacked an action');
      }
      const toolName = action.tool;
      const toolArgs = action.parameters || {};
      usedTools.push(toolName);

      let observation = '';
      let isError = false;

      try {
        observation = await this.tools.executeTool(toolName, toolArgs, toolContext);
        consecutiveErrors = 0; // Reset error streak on success
      } catch (toolErr) {
        isError = true;
        consecutiveErrors++;
        observation = `[Tool Failure] ${(toolErr as Error).message}`;
      }

      const stepTrace: StepTrace = {
        stepNumber: stepIndex,
        thought: decision.thought,
        action: { tool: toolName, input: toolArgs },
        observation,
        isError,
        latencyMs: Date.now() - stepStart,
        timestamp: new Date().toISOString(),
      };
      steps.push(stepTrace);
      this.config.onStep(stepTrace);

      // Check consecutive error circuit breaker
      if (consecutiveErrors >= this.config.consecutiveErrorsLimit) {
        status = 'circuit_broken';
        circuitBreakerReason = `Circuit breaker tripped: ${consecutiveErrors} consecutive tool failures without progress. Last error: ${observation}`;
        break;
      }

      // Update trajectory for next turn
      messages.push({
        role: 'assistant',
        content: JSON.stringify({
          thought: decision.thought,
          action: decision.action
        })
      });

      messages.push({
        role: 'user',
        content: `Tool "${toolName}" Result:\n${observation}\n\nNow reflect on this observation and decide the next step or final answer.`
      });
    }

    // 4. Post-execution Memory Commit:
    // If complex goal succeeded with 2+ tool calls, persist a procedural memory
    if (status === 'completed' && usedTools.length >= 2 && this.memoryStore) {
      const nowIso = new Date().toISOString();
      const uniqueTools = Array.from(new Set(usedTools)).join(', ');
      const proceduralContent = `Learned workflow for goal "${goal}": successfully executed using tools [${uniqueTools}].`;

      try {
        const memId = 'proc_' + Date.now();
        this.memoryStore.create({
          id: memId,
          type: 'procedural',
          status: 'active',
          content: proceduralContent,
          source_turn_id: traceId,
          importance: 0.85,
          emotional_weight: 0.0,
          recall_count: 1,
          base_half_life_hours: 2160, // 90 days
          strengthening_factor: 0.5,
          created_at: nowIso,
          last_recalled_at: nowIso,
          entities: [],
          superseded_by: null,
          consolidated_from: [],
          user_id: userId,
          session_id: 'autonomous_agent'
        });

        if (this.vectorStore && this.embedder) {
          const emb = await this.embedder.embed(proceduralContent);
          this.vectorStore.store(memId, emb);
        }
      } catch {
        // Non-fatal
      }
    }

    const totalLatencyMs = Date.now() - startTime;
    const totalToolCalls = steps.filter(s => s.action !== null).length;

    const trace: AgentExecutionTrace = {
      traceId,
      goal,
      userId,
      status,
      steps,
      totalLatencyMs,
      totalToolCalls,
      finalAnswer,
      circuitBreakerReason,
      timestamp: new Date().toISOString(),
    };

    return {
      finalAnswer,
      status,
      trace,
    };
  }
}
