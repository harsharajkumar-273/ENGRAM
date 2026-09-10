// ============================================
// Engram Core Type Definitions
// ============================================

// --- Memory Types ---

export type MemoryType = 'episodic' | 'semantic' | 'procedural';

export type MemoryStatus = 'active' | 'dormant' | 'superseded' | 'consolidated';

export type EntityType =
  | 'person'
  | 'location'
  | 'organization'
  | 'topic'
  | 'preference'
  | 'allergen'
  | 'dietary_preference'
  | 'skill'
  | 'relationship'
  | 'event'
  | 'product'
  | 'other';

/**
 * A link between a Memory and an Entity.
 */
export interface EntityLink {
  entity_id: string;
  entity_name: string;
  entity_type: EntityType;
  relation: string; // e.g., "lives_in", "works_at", "allergic_to"
}

/**
 * An entity node in the knowledge graph.
 */
export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  categories: string[]; // For spreading activation grouping
  first_seen_at: string; // ISO 8601
  last_seen_at: string;  // ISO 8601
}

/**
 * A single memory record — the core data structure of Engram.
 */
export interface Memory {
  // Identity
  id: string;
  type: MemoryType;
  status: MemoryStatus;

  // Content
  content: string;
  source_turn_id: string;

  // Scoring
  importance: number;       // 0.0–1.0, LLM-judged at creation
  emotional_weight: number; // 0.0–1.0, LLM-judged at creation

  // Decay & Reinforcement
  recall_count: number;
  base_half_life_hours: number;
  strengthening_factor: number;  // α — default 0.5
  created_at: string;            // ISO 8601
  last_recalled_at: string;      // ISO 8601

  // Relationships
  entities: EntityLink[];
  superseded_by: string | null;
  consolidated_from: string[];

  // Scoping
  user_id: string;
  session_id: string;
}

/**
 * A memory paired with its computed recall scores.
 */
export interface RecallResult {
  memory: Memory;
  similarity_score: number;   // 0.0–1.0, from vector search
  salience_score: number;     // Computed from decay formula
  association_boost: number;  // From spreading activation (Phase 5)
  final_score: number;        // Weighted combination
}

// --- Memory Extraction Types ---

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  relation: string;
}

export interface ExtractedMemory {
  content: string;
  type: MemoryType;
  importance: number;        // 0.0–1.0
  emotional_weight: number;  // 0.0–1.0
  entities: ExtractedEntity[];
  reasoning: string;         // Explanation for why this fact was extracted and scored
}

export interface ExtractionResult {
  memories: ExtractedMemory[];
}

// --- Contradiction Types ---

export interface ContradictionRecord {
  id: string;
  old_memory_id: string;
  new_memory_id: string;
  old_content: string;
  new_content: string;
  confidence: number;
  reasoning: string;
  detected_at: string;
}

export interface ContradictionEvaluation {
  old_memory_id: string;
  classification: 'CONTRADICTION' | 'ENTAILMENT' | 'NEUTRAL';
  confidence: number;
  reasoning: string;
}

// --- Configuration ---

export interface EngineConfig {
  // Half-lives by memory type (hours)
  episodic_half_life_hours: number;
  semantic_half_life_hours: number;
  procedural_half_life_hours: number;

  // Spaced repetition
  strengthening_factor: number; // α — each recall multiplies half-life by (1 + α)

  // Pruning
  pruning_threshold: number; // Salience below this → dormant

  // Consolidation
  consolidation_interval_hours: number;

  // Deduplication
  dedup_threshold: number; // Cosine similarity above this → deduplicate

  // Contradiction
  contradiction_similarity_threshold: number; // Min similarity to consider for contradictions

  // Recall
  max_recall_results: number;

  // Storage
  db_path: string;
}

export const DEFAULT_CONFIG: EngineConfig = {
  episodic_half_life_hours: 72,       // 3 days
  semantic_half_life_hours: 720,      // 30 days
  procedural_half_life_hours: 2160,   // 90 days
  strengthening_factor: 0.5,
  pruning_threshold: 0.01,
  consolidation_interval_hours: 6,
  dedup_threshold: 0.92,
  contradiction_similarity_threshold: 0.3,
  max_recall_results: 10,
  db_path: './engram.db',
};

/**
 * Returns the base half-life for a given memory type.
 */
export function getBaseHalfLife(type: MemoryType, config: EngineConfig): number {
  switch (type) {
    case 'episodic':
      return config.episodic_half_life_hours;
    case 'semantic':
      return config.semantic_half_life_hours;
    case 'procedural':
      return config.procedural_half_life_hours;
  }
}

// --- LLM / Provider Types ---

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
}

// --- Time Provider ---

/**
 * Abstraction over the system clock for testability.
 * All Engram components use this instead of Date.now() directly.
 * This prevents the timestamp bug that Synapse had.
 */
export interface TimeProvider {
  now(): Date;
}

/**
 * Uses the real system clock.
 */
export class RealTimeProvider implements TimeProvider {
  now(): Date {
    return new Date();
  }
}

/**
 * Manually controllable clock for testing and benchmarks.
 * Allows fast-forwarding time to observe decay behavior.
 */
export class SimulatedTimeProvider implements TimeProvider {
  private _now: Date;

  constructor(startTime?: Date) {
    this._now = startTime ?? new Date();
  }

  now(): Date {
    return new Date(this._now.getTime());
  }

  /** Advance the clock by a number of hours. */
  advance(hours: number): void {
    this._now = new Date(this._now.getTime() + hours * 60 * 60 * 1000);
  }

  /** Advance the clock by a number of days. */
  advanceDays(days: number): void {
    this.advance(days * 24);
  }

  /** Set the clock to a specific time. */
  set(time: Date): void {
    this._now = new Date(time.getTime());
  }
}

// --- Utility Types ---

/**
 * Row returned from SQLite for a memory record.
 * Uses snake_case to match the database schema.
 */
export interface MemoryRow {
  id: string;
  type: string;
  status: string;
  content: string;
  source_turn_id: string;
  importance: number;
  emotional_weight: number;
  recall_count: number;
  base_half_life: number;
  strength_factor: number;
  created_at: string;
  last_recalled_at: string;
  superseded_by: string | null;
  consolidated_from: string | null; // JSON string
  user_id: string;
  session_id: string;
}

/**
 * Row for a memory-entity link in the database.
 */
export interface MemoryEntityRow {
  memory_id: string;
  entity_id: string;
  entity_name: string;
  entity_type: string;
  relation: string;
}

/**
 * A vector search result before full memory hydration.
 */
export interface VectorSearchResult {
  memory_id: string;
  similarity: number;
}
