// ============================================================================
// Engram Agent Observability & Tracing Harness
// ============================================================================

export interface StepTrace {
  stepNumber: number;
  thought: string;
  action: {
    tool: string;
    input: Record<string, any>;
  } | null;
  observation: string | null;
  isError: boolean;
  latencyMs: number;
  timestamp: string;
}

export interface AgentExecutionTrace {
  traceId: string;
  goal: string;
  userId: string;
  status: 'completed' | 'failed' | 'circuit_broken' | 'max_steps_exceeded';
  steps: StepTrace[];
  totalLatencyMs: number;
  totalToolCalls: number;
  finalAnswer: string | null;
  circuitBreakerReason?: string;
  timestamp: string;
}

/**
 * Formats an execution trace into a human-readable summary for logs and reports.
 */
export function formatTraceSummary(trace: AgentExecutionTrace): string {
  const statusEmoji = trace.status === 'completed' ? '✅' : '❌';
  let report = `${statusEmoji} Agent Goal Execution: "${trace.goal}"\n`;
  report += `   Trace ID: ${trace.traceId} | Status: ${trace.status.toUpperCase()} | Steps: ${trace.steps.length}\n`;
  report += `   Total Latency: ${trace.totalLatencyMs}ms | Tool Calls: ${trace.totalToolCalls}\n\n`;

  for (const step of trace.steps) {
    report += `─── Step ${step.stepNumber} [${step.latencyMs}ms] ───\n`;
    report += `💭 Thought: ${step.thought}\n`;
    if (step.action) {
      report += `🛠️ Action: ${step.action.tool}(${JSON.stringify(step.action.input)})\n`;
      report += `👁️ Observation: ${step.isError ? '❌ ' : ''}${step.observation?.slice(0, 300) || '(none)'}${step.observation && step.observation.length > 300 ? '...' : ''}\n`;
    }
    report += '\n';
  }

  if (trace.finalAnswer) {
    report += `🎯 Final Answer:\n${trace.finalAnswer}\n`;
  }

  if (trace.circuitBreakerReason) {
    report += `⚠️ Circuit Breaker Triggered: ${trace.circuitBreakerReason}\n`;
  }

  return report;
}

/**
 * Produces ANSI colored terminal formatting for real-time streaming of an agent step.
 */
export function formatTerminalStep(step: StepTrace): string {
  let out = `\x1b[36m💭 [Step ${step.stepNumber} Thought]\x1b[0m ${step.thought}\n`;
  if (step.action) {
    out += `\x1b[33m🛠️ [Action]\x1b[0m ${step.action.tool}(${JSON.stringify(step.action.input)})\n`;
    const obsColor = step.isError ? '\x1b[31m' : '\x1b[90m';
    const obsPrefix = step.isError ? '❌ [Tool Error]' : '👁️ [Observation]';
    out += `${obsColor}${obsPrefix} ${step.observation}\x1b[0m\n`;
  }
  return out;
}
