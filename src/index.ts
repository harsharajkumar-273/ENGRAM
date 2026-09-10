// ============================================================================
// Engram — Cognitive AI Memory Architecture
// ============================================================================

// Agent orchestrator & Autonomous Engine
export { EngramAgent } from './agent.js';
export type { ChatResult } from './agent.js';
export { AutonomousAgent } from './agent/autonomous.js';
export type { AutonomousAgentConfig, AgentExecutionResult } from './agent/autonomous.js';
export {
  ToolRegistry,
  createDefaultToolRegistry,
  calculatorTool,
  fileReadTool,
  fileWriteTool,
  memorySearchTool,
  memoryStoreTool,
  shellExecTool,
} from './agent/tools.js';
export type { ToolDefinition, ToolContext } from './agent/tools.js';
export { formatTraceSummary, formatTerminalStep } from './agent/telemetry.js';
export type { StepTrace, AgentExecutionTrace } from './agent/telemetry.js';

// Core types & configuration
export type {
  Memory,
  MemoryType,
  MemoryStatus,
  EntityType,
  Entity,
  EntityLink,
  RecallResult,
  ExtractedEntity,
  ExtractedMemory,
  ExtractionResult,
  ContradictionRecord,
  ContradictionEvaluation,
  EngineConfig,
  Message,
  ChatOptions,
  TimeProvider,
} from './core/types.js';

export {
  DEFAULT_CONFIG,
  getBaseHalfLife,
  RealTimeProvider,
  SimulatedTimeProvider,
} from './core/types.js';

// Salience, Ebbinghaus decay, and adaptive half-life models
export {
  computeSalience,
  getAdaptiveHalfLife,
  isMemoryDormant,
  hoursUntilDormant,
  diffHours,
} from './core/salience.js';

// Emotional weight rubrics & persistence multipliers
export {
  clampEmotionalWeight,
  getEmotionalDecayMultiplier,
  classifyEmotionalWeight,
} from './core/emotional.js';
export type { EmotionalClassification } from './core/emotional.js';

// Knowledge extraction
export { extractMemories } from './core/extraction.js';

// Storage engines
export { initDatabase } from './storage/database.js';
export { MemoryStore } from './storage/memory-store.js';
export { VectorStore, cosineSimilarity } from './storage/vector-store.js';
export { GraphStore } from './storage/graph-store.js';

// Multi-signal recall & spreading activation
export { retrieveMemories } from './recall/retrieval.js';
export type { RetrievalOptions } from './recall/retrieval.js';
export { computeSpreadingActivation } from './recall/spreading-activation.js';
export type { ActivationBoost } from './recall/spreading-activation.js';

// Cognitive lifecycle processes
export {
  detectContradictions,
  resolveContradictions,
} from './processes/contradiction.js';
export { runDecaySweep } from './processes/decay-sweep.js';
export type { DecaySweepReport } from './processes/decay-sweep.js';
export { ConsolidationEngine } from './processes/consolidation.js';
export { detectProceduralPatterns } from './processes/procedural.js';

// Provider abstractions & implementations
export type { LLMProvider, EmbeddingProvider } from './providers/interface.js';
export { GeminiLLMProvider, GeminiEmbeddingProvider } from './providers/gemini.js';
