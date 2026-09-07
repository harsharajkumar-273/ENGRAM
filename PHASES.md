# Engram — Phased Implementation Plan

> A step-by-step roadmap broken into 7 phases, each delivering a working, testable increment.
> Each phase builds on the previous one. You can ship and use the project after completing any phase.

---

## Phase Overview

```
Phase 1: The Skeleton          (Days 1–2)   → Project setup, types, SQLite, basic CLI
Phase 2: Memory Extraction     (Days 3–4)   → LLM-powered memory creation from conversations
Phase 3: Decay Engine          (Days 5–6)   → Ebbinghaus decay + spaced repetition math
Phase 4: Contradiction Engine  (Days 7–9)   → NLI-based contradiction detection & resolution
Phase 5: The Graph             (Days 10–12) → Entity extraction, graph storage, spreading activation
Phase 6: Consolidation         (Days 13–15) → Abstractive sleep pass, episodic → semantic promotion
Phase 7: Benchmarking          (Days 16–20) → 3 baselines, 3 scenarios, 6 metrics, honest reporting
```

```
         Phase 1          Phase 2          Phase 3          Phase 4
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │  Skeleton    │→│  Extraction  │→│  Decay       │→│ Contradiction│
    │  & Storage   │ │  Pipeline    │ │  Engine      │ │  Detection   │
    │              │ │              │ │              │ │              │
    │ • Types      │ │ • LLM calls  │ │ • Salience   │ │ • NLI judge  │
    │ • SQLite     │ │ • Structured │ │ • Half-life  │ │ • Supersede  │
    │ • Vector DB  │ │   output     │ │ • Spaced rep │ │ • Conflict   │
    │ • Basic CLI  │ │ • Emotional  │ │ • Pruning    │ │   log        │
    │ • Provider   │ │   scoring    │ │ • Decay sweep│ │              │
    │   interface  │ │ • Dedup      │ │              │ │              │
    └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
           │                │                │                │
           ▼                ▼                ▼                ▼
       Milestone:       Milestone:       Milestone:       Milestone:
       "Can store &     "Conversations   "Memories fade   "Old facts are
        retrieve raw     auto-create      over time like   auto-retired
        memories"        memories"        real memory"     when updated"

         Phase 5          Phase 6          Phase 7
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │  Entity      │→│ Consolidation│→│ Benchmarking │
    │  Graph       │ │  (Sleep)     │ │  & Polish    │
    │              │ │              │ │              │
    │ • Entity     │ │ • Clustering │ │ • 3 Baselines│
    │   extraction │ │ • Abstractive│ │ • 3 Scenarios│
    │ • Graph DB   │ │   summaries  │ │ • 6 Metrics  │
    │ • Spreading  │ │ • Episodic → │ │ • Reports    │
    │   activation │ │   semantic   │ │ • README     │
    │ • Hybrid     │ │ • Procedural │ │ • npm publish│
    │   recall     │ │   detection  │ │              │
    └──────────────┘ └──────────────┘ └──────────────┘
           │                │                │
           ▼                ▼                ▼
       Milestone:       Milestone:       Milestone:
       "Asking about    "5 mentions of   "Proof it works
        dinner pulls     hackathon →      with real numbers
        in allergies"    1 rich summary"  anyone can verify"
```

---

---

# Phase 1: The Skeleton & Storage

**Goal:** Set up the project, define all types, initialize SQLite with vector search, build the provider interface, and create a basic interactive CLI that can manually store and retrieve memories.

**Duration:** Days 1–2

### What You Build

```
engram/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── core/
│   │   └── types.ts              # All TypeScript interfaces
│   ├── storage/
│   │   ├── database.ts           # SQLite init, migrations, connection
│   │   ├── memory-store.ts       # CRUD: create, read, update, delete memories
│   │   └── vector-store.ts       # sqlite-vec: store & search embeddings
│   ├── providers/
│   │   ├── interface.ts          # LLMProvider & EmbeddingProvider interfaces
│   │   └── gemini.ts             # First provider implementation
│   └── cli.ts                    # Basic REPL that can /remember and /recall
└── tests/
    ├── memory-store.test.ts
    └── vector-store.test.ts
```

### Tasks

#### 1.1 Project Initialization
- [ ] Initialize npm project with TypeScript
- [ ] Install core dependencies:
  - `better-sqlite3` — SQLite driver
  - `sqlite-vec` — Vector search extension for SQLite
  - `dotenv` — Environment variable loading
  - `uuid` — Memory ID generation
  - `vitest` — Test runner
- [ ] Configure `tsconfig.json` (strict mode, ESM)
- [ ] Create `.env.example` with all configurable values

#### 1.2 Type Definitions (`src/core/types.ts`)
- [ ] Define `Memory` interface (id, type, status, content, importance, emotional_weight, recall_count, base_half_life, strengthening_factor, timestamps, entities, superseded_by, consolidated_from, user_id, session_id)
- [ ] Define `EntityLink` interface (entity_id, entity_name, entity_type, relation)
- [ ] Define `Entity` interface (id, name, type, categories, first/last seen)
- [ ] Define `MemoryType` enum (episodic, semantic, procedural)
- [ ] Define `MemoryStatus` enum (active, dormant, superseded, consolidated)
- [ ] Define `RecallResult` interface (memory, similarity_score, salience_score, association_boost, final_score)
- [ ] Define `EngineConfig` interface (all configurable parameters with defaults)

#### 1.3 SQLite Database (`src/storage/database.ts`)
- [ ] Create database initialization function
- [ ] Write migration: `memories` table
- [ ] Write migration: `memory_vectors` virtual table (sqlite-vec)
- [ ] Write migration: `entities` table
- [ ] Write migration: `entity_categories` table
- [ ] Write migration: `memory_entities` join table
- [ ] Write migration: `contradictions` log table
- [ ] Write migration: `consolidations` history table
- [ ] Add migration versioning (simple `schema_version` table)

#### 1.4 Memory Store (`src/storage/memory-store.ts`)
- [ ] `createMemory(memory)` — Insert a memory record
- [ ] `getMemory(id)` — Fetch a single memory by ID
- [ ] `getActiveMemories(userId)` — Fetch all active memories for a user
- [ ] `updateRecallStats(id)` — Increment recall_count, update last_recalled_at
- [ ] `updateStatus(id, status, supersededBy?)` — Mark as dormant/superseded/consolidated
- [ ] `deleteMemory(id)` — Hard delete (for pruned dormant memories)
- [ ] `getMemoriesByStatus(status)` — List memories by status
- [ ] `countMemories(userId)` — Count active memories

#### 1.5 Vector Store (`src/storage/vector-store.ts`)
- [ ] `storeEmbedding(id, vector)` — Insert an embedding
- [ ] `searchSimilar(queryVector, topK, threshold)` — Cosine similarity search
- [ ] `deleteEmbedding(id)` — Remove an embedding
- [ ] Verify sqlite-vec loads correctly on macOS/Linux

#### 1.6 Provider Interface (`src/providers/interface.ts`)
- [ ] Define `LLMProvider` interface:
  ```typescript
  interface LLMProvider {
    chat(messages: Message[], options?: ChatOptions): Promise<string>;
    chatJSON<T>(messages: Message[], schema: object): Promise<T>;
  }
  ```
- [ ] Define `EmbeddingProvider` interface:
  ```typescript
  interface EmbeddingProvider {
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
    dimensions: number;
  }
  ```

#### 1.7 Gemini Provider (`src/providers/gemini.ts`)
- [ ] Implement `LLMProvider` using `@google/genai` SDK
- [ ] Implement `EmbeddingProvider` using `text-embedding-004`
- [ ] Add retry logic with exponential backoff (3 retries)
- [ ] Add structured output (JSON schema) support

#### 1.8 Basic CLI (`src/cli.ts`)
- [ ] Interactive REPL using Node.js `readline`
- [ ] Commands:
  - `/remember <text>` — Manually store a memory with a generated embedding
  - `/recall <query>` — Search memories by vector similarity and display results
  - `/memories` — List all stored memories with metadata
  - `/stats` — Show memory counts by type and status
  - `/clear` — Delete all memories
  - `/quit` — Exit
- [ ] Display formatting: show memory content, type, importance, recall count

#### 1.9 Tests
- [ ] Test memory CRUD operations
- [ ] Test vector store: insert, search, delete
- [ ] Test that sqlite-vec returns results sorted by similarity
- [ ] Test database migration runs cleanly on fresh DB

### Milestone Deliverable
A working CLI where you can manually store text as memories, search for them using natural language queries (vector similarity), and see all stored memories with metadata. No LLM intelligence yet — just the plumbing.

### Verification
```bash
npm run test              # All storage tests pass
npm run cli               # Can /remember and /recall successfully
```

---

---

# Phase 2: Memory Extraction Pipeline

**Goal:** When a user chats naturally, the system automatically extracts, scores, deduplicates, and stores memories. The user no longer needs to manually `/remember` — the agent handles it.

**Duration:** Days 3–4

### What You Build

```
src/
├── core/
│   ├── types.ts              # (update: ExtractionResult type)
│   ├── extraction.ts         # NEW — LLM-based memory extraction
│   └── emotional.ts          # NEW — Emotional weight scoring
├── agent.ts                  # NEW — Main agent loop (chat + auto-extraction)
└── cli.ts                    # UPDATE — Full chat mode, not just commands
```

### Tasks

#### 2.1 Memory Extraction (`src/core/extraction.ts`)
- [ ] Design the extraction prompt:
  ```
  Given the following conversation turn, extract any memories worth storing.
  
  EXTRACT:
  - Facts about the user (location, job, relationships, preferences)
  - Decisions the user has made
  - Life events (moving, new job, health, milestones)
  - Explicit requests to remember something
  - Strong opinions or beliefs
  
  SKIP:
  - Small talk and filler ("okay", "thanks", "sounds good")
  - Information the AI said (not user-originated)
  - Vague or context-free statements
  - Questions without embedded facts
  ```
- [ ] Define `ExtractionResult` schema for structured LLM output:
  ```typescript
  interface ExtractionResult {
    memories: {
      content: string;
      type: "episodic" | "semantic";
      importance: number;        // 0.0–1.0
      emotional_weight: number;  // 0.0–1.0
      entities: { name: string; type: string; relation: string }[];
      reasoning: string;         // Why this was extracted (for debugging)
    }[];
  }
  ```
- [ ] Implement `extractMemories(turn, context)` function
- [ ] Add retry-on-invalid-shape wrapper (retry up to 3 times if JSON fails validation)
- [ ] Add input sanitization (strip extremely long messages, cap at 4000 chars)

#### 2.2 Importance Scoring Rubric
- [ ] Define the scoring rubric given to the LLM:
  ```
  0.0–0.2: Trivial (weather chat, greetings, fillers)
  0.3–0.4: Minor preference or passing mention
  0.5–0.6: Noteworthy fact or moderate preference
  0.7–0.8: Important life fact (job, location, relationship)
  0.9–1.0: Critical safety/health info or explicit "remember this"
  ```
- [ ] Include scoring examples in the prompt for calibration

#### 2.3 Emotional Weight Scoring (`src/core/emotional.ts`)
- [ ] Define the emotional scoring rubric:
  ```
  0.0–0.1: Completely neutral / mundane
  0.2–0.4: Mild interest or casual preference
  0.5–0.7: Significant personal relevance (new job, breakup, move)
  0.8–1.0: Deeply emotional / life-changing (diagnosis, death, birth, fired)
  ```
- [ ] Emotional scoring is done within the same extraction call (not separate) to reduce API costs

#### 2.4 Deduplication
- [ ] Before storing a new memory, embed it and search for existing similar memories
- [ ] If cosine similarity > 0.92 with an existing active memory:
  - Do NOT create a new memory
  - Instead, increment the existing memory's `recall_count` (it was "mentioned again")
  - Update `last_recalled_at`
  - Log the dedup event
- [ ] If similarity is between 0.70 and 0.92:
  - Store as a new memory (it's related but distinct)
  - Note: This range will later be used by consolidation (Phase 6)

#### 2.5 Agent Loop (`src/agent.ts`)
- [ ] Create `EngramAgent` class:
  ```typescript
  class EngramAgent {
    constructor(config: EngineConfig, llm: LLMProvider, embedder: EmbeddingProvider)
    
    async chat(userMessage: string): Promise<string>
    // 1. Add user message to working memory (last 7 turns)
    // 2. Recall relevant memories for context
    // 3. Build system prompt with recalled memories
    // 4. Get LLM response
    // 5. Extract and store new memories from the turn
    // 6. Return the response
  }
  ```
- [ ] Working memory buffer: store last 7 turns as an array
- [ ] Memory injection: format recalled memories into the system prompt:
  ```
  ## Your Memories About This User
  - [Semantic, Importance: 0.85] User lives in Lisbon and works at Stripe
  - [Episodic, Importance: 0.70] User mentioned debugging a memory system last week
  - [Semantic, Importance: 0.95] User is allergic to peanuts
  ```

#### 2.6 Updated CLI (`src/cli.ts`)
- [ ] Default mode is now **chat mode** (type naturally, get responses)
- [ ] Agent auto-extracts memories from every turn
- [ ] After each turn, show a subtle indicator:
  ```
  💾 Extracted 2 memories | 📊 Total: 14 active memories
  ```
- [ ] Retain slash commands (`/memories`, `/stats`, `/recall`, `/clear`, `/quit`)
- [ ] Add `/debug` toggle — when on, show extracted memories and their scores after each turn

#### 2.7 Tests
- [ ] Test extraction with sample conversation turns:
  - "I just moved to Lisbon" → should extract location memory
  - "Thanks, sounds good" → should extract nothing
  - "I'm allergic to penicillin, please remember that" → should extract with importance ~0.95
- [ ] Test deduplication: saying "I live in Lisbon" twice should not create two memories
- [ ] Test emotional scoring: "I got fired" should score > 0.7 emotional weight
- [ ] Test agent loop end-to-end: send 5 messages, verify memories were created

### Milestone Deliverable
A conversational AI agent that automatically remembers important things you tell it. You can chat naturally, and it silently builds a memory of who you are. When you ask something it should know, it recalls relevant memories and uses them in its response.

### Verification
```bash
npm run test              # All extraction + agent tests pass
npm run cli               # Chat naturally, see memories being created
# Test: Tell it "I'm vegetarian and allergic to peanuts"
# Then later ask "What should I eat for dinner?"
# It should reference both facts in its response.
```

---

---

# Phase 3: Decay Engine

**Goal:** Memories now decay over time. Frequently recalled memories become harder to forget (spaced repetition). A background sweep prunes dead memories. The memory system is now *alive* — it breathes.

**Duration:** Days 5–6

### What You Build

```
src/
├── core/
│   └── salience.ts           # NEW — All decay math
├── processes/
│   └── decay-sweep.ts        # NEW — Background decay computation & pruning
└── recall/
    └── retrieval.ts          # UPDATE — Factor salience into recall ranking
```

### Tasks

#### 3.1 Salience Calculator (`src/core/salience.ts`)
- [ ] Implement the core salience formula:
  ```typescript
  function computeSalience(memory: Memory, now: Date): number {
    const hoursSinceLastRecall = diffHours(now, memory.last_recalled_at);
    const adaptiveHalfLife = memory.base_half_life 
                           * Math.pow(1 + memory.strengthening_factor, memory.recall_count);
    const decayFactor = Math.exp(-Math.LN2 / adaptiveHalfLife * hoursSinceLastRecall);
    const recallBoost = 1 + Math.log(1 + memory.recall_count);
    const emotionalMultiplier = 1 + memory.emotional_weight;
    
    return memory.importance * recallBoost * decayFactor * emotionalMultiplier;
  }
  ```
- [ ] Implement `isMemoryDormant(salience)` — returns true if salience < 0.01
- [ ] Implement `getAdaptiveHalfLife(memory)` — for debugging/display
- [ ] Implement `hoursUntilDormant(memory, now)` — predict when a memory will be pruned
- [ ] Accept a `now` parameter everywhere (not `Date.now()`) for testability and simulation
  - **This is the exact bug Synapse had.** We avoid it by design.

#### 3.2 Updated Recall (`src/recall/retrieval.ts`)
- [ ] Modify recall pipeline:
  1. Vector search returns top-30 candidates
  2. For each candidate, compute current salience
  3. Filter out dormant memories (salience < 0.01)
  4. Final score = `0.5 × similarity + 0.5 × salience`
  5. Return top-10 by final score
- [ ] Update `recall_count` and `last_recalled_at` for all returned memories (spaced repetition trigger)

#### 3.3 Decay Sweep (`src/processes/decay-sweep.ts`)
- [ ] `runDecaySweep(now)`:
  1. Fetch all active memories
  2. Compute salience for each
  3. Mark memories with salience < 0.01 as "dormant"
  4. Delete dormant memories older than 7 days (grace period)
  5. Return a sweep report: `{ checked: N, marked_dormant: N, deleted: N }`
- [ ] Configurable sweep interval (default: every simulated hour)
- [ ] Log sweep results for debugging

#### 3.4 Simulated Time Support
- [ ] Add `TimeProvider` interface:
  ```typescript
  interface TimeProvider {
    now(): Date;
    advance(hours: number): void;  // For testing/simulation
  }
  ```
- [ ] `RealTimeProvider` — uses actual system clock
- [ ] `SimulatedTimeProvider` — manually controllable clock for benchmarks
- [ ] All components accept `TimeProvider` via dependency injection
- [ ] **This is critical for benchmarking (Phase 7)** — Synapse's biggest bug was using real `datetime.now()` in some functions while simulating time in others

#### 3.5 CLI Updates
- [ ] Add `/time advance <hours>` command — fast-forward simulated time to watch memories decay
- [ ] Update `/memories` to show current salience alongside each memory:
  ```
  [0.85] (semantic) User lives in Lisbon — recalled 3x, half-life: 243h
  [0.12] (episodic) User had pasta for dinner — recalled 0x, half-life: 72h
  [0.01] (episodic) Weather was nice on Tuesday — DORMANT
  ```
- [ ] Add `/decay` command — manually trigger a decay sweep and show results

#### 3.6 Tests
- [ ] Test salience computation with known inputs:
  - Fresh memory with importance 0.8 → salience ~0.8
  - Same memory after 72 hours (1 half-life) → salience ~0.4
  - Same memory after 144 hours (2 half-lives) → salience ~0.2
- [ ] Test spaced repetition:
  - Memory recalled 5 times should have much higher salience than unreinforced memory after same elapsed time
- [ ] Test adaptive half-life growth:
  - 0 recalls → H = 72h
  - 5 recalls with α=0.5 → H = 72 × 1.5^5 ≈ 547h
- [ ] Test decay sweep:
  - Create memories with varying importance, advance time, run sweep, verify correct ones are pruned
- [ ] Test that `SimulatedTimeProvider` is used consistently (no `Date.now()` leaks)
- [ ] Test emotional multiplier: high-emotion memories should survive longer than neutral ones

### Milestone Deliverable
A memory system that *lives and breathes*. Trivial memories ("nice weather") fade within days. Important memories ("allergic to peanuts") persist for months. Memories that are frequently useful (recalled often) become nearly permanent. You can fast-forward time and watch the system naturally forget.

### Verification
```bash
npm run test              # All decay tests pass
npm run cli
# Tell it several things of varying importance
# /time advance 100
# /memories → Trivial memories should be faded/dormant
# /time advance 500
# /memories → Only important + frequently recalled memories survive
```

---

---

# Phase 4: Contradiction Engine

**Goal:** When the user's facts change ("I moved from Berlin to Lisbon"), the system detects the contradiction and automatically retires the outdated memory. No more stale data.

**Duration:** Days 7–9

### What You Build

```
src/
├── processes/
│   └── contradiction.ts      # NEW — NLI-based contradiction detection
├── storage/
│   └── memory-store.ts       # UPDATE — supersede/log operations
└── core/
    └── extraction.ts         # UPDATE — trigger contradiction check on new writes
```

### Tasks

#### 4.1 Contradiction Detector (`src/processes/contradiction.ts`)
- [ ] `detectContradictions(newMemory, existingMemories, llm)`:
  1. Embed the new memory
  2. Find top-20 most similar existing memories (low threshold: 0.3)
  3. For each candidate, run NLI classification
- [ ] NLI Classification prompt:
  ```
  You are a contradiction detector. Given two statements about a user, 
  classify their relationship.
  
  Statement A (existing, older): "{old_memory}"
  Statement B (new, recent): "{new_memory}"
  
  Classify as:
  - CONTRADICTION: B directly conflicts with A. They cannot both be true 
    at the same time. (e.g., different locations, jobs, preferences)
  - ENTAILMENT: B is consistent with A, or B adds detail to A.
  - NEUTRAL: No clear logical relationship.
  
  Respond in JSON:
  {
    "classification": "CONTRADICTION" | "ENTAILMENT" | "NEUTRAL",
    "confidence": 0.0-1.0,
    "reasoning": "Brief explanation"
  }
  ```
- [ ] Only process pairs where the NLI model returns CONTRADICTION with confidence > 0.7
- [ ] **Batch optimization:** Group multiple candidates into a single LLM call when possible to reduce API costs

#### 4.2 Contradiction Resolution
- [ ] When a contradiction is confirmed:
  1. Compare timestamps — the **newer** memory wins
  2. Mark the older memory as `status: "superseded"`, set `superseded_by: newMemory.id`
  3. The newer memory inherits any recall count from the older one (knowledge transfer)
  4. Log the contradiction in the `contradictions` table with full reasoning
- [ ] Edge case: if both memories have the same timestamp (simultaneous), flag for manual review (log a warning, keep both)

#### 4.3 Integration with Extraction Pipeline
- [ ] After `extractMemories()` creates a new memory, automatically call `detectContradictions()` before returning
- [ ] Flow:
  ```
  User says something
    → Extract memories
    → For each extracted memory:
        → Check for contradictions against existing memories
        → If contradiction found: supersede the old one
        → Store the new memory
  ```

#### 4.4 Contradiction Log & Transparency
- [ ] Store every detected contradiction:
  ```typescript
  interface ContradictionRecord {
    id: string;
    old_memory_id: string;
    new_memory_id: string;
    old_content: string;
    new_content: string;
    confidence: number;
    reasoning: string;
    detected_at: string;
  }
  ```
- [ ] CLI command `/contradictions` — show all detected contradictions with reasoning:
  ```
  ┌─────────────────────────────────────────────────────────┐
  │ Contradiction detected at 2026-09-10T14:30:00           │
  │ OLD: "User lives in Berlin"                             │
  │ NEW: "User just moved to Lisbon"                        │
  │ Confidence: 0.94                                        │
  │ Reasoning: "Direct location conflict — user can only    │
  │            live in one place at a time"                  │
  │ Resolution: Old memory superseded                       │
  └─────────────────────────────────────────────────────────┘
  ```

#### 4.5 Tests
- [ ] Test direct contradiction: "I live in Berlin" → "I moved to Lisbon" → Berlin memory superseded
- [ ] Test rephrased contradiction: "I'm a software engineer" → "I switched careers to become a chef" → engineer memory superseded
- [ ] Test NON-contradiction (refinement): "I work at Google" → "I work on the Maps team at Google" → both should coexist
- [ ] Test NON-contradiction (unrelated): "I like pizza" → "I moved to Lisbon" → no contradiction
- [ ] Test timestamp resolution: newer always wins
- [ ] Test recall count inheritance: superseded memory's recall count transfers to new one
- [ ] Test low-similarity contradictions that cosine would miss:
  - "I'm vegetarian" vs "I had the best steak at the restaurant last night" (cosine ~0.31, but NLI catches it)

### Milestone Deliverable
Tell the agent you live in Berlin. Three weeks later, tell it you moved to Lisbon. Ask "Where do I live?" — it answers "Lisbon" without hesitation. The Berlin memory is retired with a full audit trail. This is the literal "timely forgetting of outdated information" that most systems can't do.

### Verification
```bash
npm run test              # All contradiction tests pass
npm run cli
# Tell it: "I work at Google as a software engineer"
# Then: "I just started a new job at Stripe"
# Ask: "Where do I work?"
# Expected: "Stripe" — NOT "Google"
# /contradictions → shows the detected conflict with reasoning
```

---

---

# Phase 5: The Entity Graph & Associative Recall

**Goal:** Memories are now connected through shared entities. Asking about dinner pulls in both "vegetarian" AND "peanut allergy" through graph connections, even though peanuts have nothing to do with dinner in embedding space.

**Duration:** Days 10–12

### What You Build

```
src/
├── storage/
│   └── graph-store.ts            # NEW — Entity & relationship storage
├── recall/
│   ├── spreading-activation.ts   # NEW — Graph traversal for associative boost
│   └── retrieval.ts              # UPDATE — Hybrid: vector + salience + association
└── core/
    └── extraction.ts             # UPDATE — Extract entities alongside memories
```

### Tasks

#### 5.1 Entity Extraction (Update `extraction.ts`)
- [ ] Extend the extraction prompt to also extract entities and relationships:
  ```json
  {
    "memories": [...],
    "entities": [
      { "name": "Lisbon", "type": "location", "categories": ["places", "europe"] },
      { "name": "Stripe", "type": "organization", "categories": ["tech_companies", "employer"] }
    ],
    "relations": [
      { "memory_index": 0, "entity_name": "Lisbon", "relation": "lives_in" },
      { "memory_index": 1, "entity_name": "Stripe", "relation": "works_at" }
    ]
  }
  ```
- [ ] Entity types: person, location, organization, topic, preference, allergen, dietary_preference, skill, relationship, event, product
- [ ] Auto-assign categories based on entity type (e.g., allergen → "dietary_restrictions", "health")
- [ ] Entity deduplication: normalize names (case-insensitive, trim whitespace), merge if same name + type

#### 5.2 Graph Store (`src/storage/graph-store.ts`)
- [ ] `createEntity(entity)` — Store an entity, deduplicate by name+type
- [ ] `linkMemoryToEntity(memoryId, entityId, relation)` — Create an edge
- [ ] `getEntitiesForMemory(memoryId)` — Get all entities linked to a memory
- [ ] `getMemoriesForEntity(entityId)` — Get all memories linked to an entity
- [ ] `getEntitiesByCategory(category)` — Get all entities in a category
- [ ] `getRelatedEntities(entityId, maxHops)` — Traverse graph (1-hop default)
- [ ] `getEntityByName(name, type)` — Lookup for deduplication

#### 5.3 Spreading Activation (`src/recall/spreading-activation.ts`)
- [ ] `computeAssociationBoosts(directResults, graphStore)`:
  1. Extract all entities from the direct recall results
  2. For each entity, find other entities in the same category
  3. For each related entity, find memories linked to it
  4. Assign boost scores:
     - Direct entity match: boost = 0.3
     - Same-category entity (1-hop): boost = 0.15
  5. Return a map of `memoryId → association_boost`
- [ ] Deduplicate: if a memory is already in the direct results, don't double-count
- [ ] Cap the number of associated memories to 10 (prevent explosion)

#### 5.4 Hybrid Recall Pipeline (Update `retrieval.ts`)
- [ ] New scoring formula:
  ```
  final_score = 0.4 × similarity + 0.4 × salience + 0.2 × association_boost
  ```
- [ ] Updated pipeline:
  1. Embed query
  2. Vector search → top 30 candidates
  3. Compute salience for each → filter dormant
  4. Compute association boosts via spreading activation
  5. Merge direct results + associated results
  6. Compute final score → re-rank
  7. Return top 10
  8. Update recall stats for returned memories

#### 5.5 CLI Updates
- [ ] Add `/entities` command — show all entities and their categories
- [ ] Add `/graph <entity>` command — show what a specific entity is connected to:
  ```
  Entity: "Peanuts" (allergen)
  Categories: dietary_restrictions, health
  Connected memories:
    → "User is allergic to peanuts" (importance: 0.95)
  Related entities (same category):
    → "Vegetarian" (dietary_preference) — 1 linked memory
    → "Shellfish" (allergen) — 1 linked memory
  ```
- [ ] Update `/recall` to show association source when applicable:
  ```
  1. [0.85] User is vegetarian — (direct match)
  2. [0.72] User is allergic to peanuts — (associated via: dietary_restrictions)
  ```

#### 5.6 Tests
- [ ] Test entity extraction: "I work at Stripe in Lisbon" → entities: [Stripe/org, Lisbon/location]
- [ ] Test entity deduplication: "Lisbon" mentioned twice → only one entity created
- [ ] Test graph traversal: peanut allergy and vegetarian linked through "dietary_restrictions" category
- [ ] Test spreading activation: query about "dinner" surfaces peanut allergy via graph (not just vector similarity)
- [ ] Test that association boost doesn't overwhelm direct relevance
- [ ] Test 1-hop limit: activation doesn't spread infinitely

### Milestone Deliverable
Ask "What should I cook for dinner?" and the system returns not just "User is vegetarian" (direct semantic match) but also "User is allergic to peanuts" (associated through the entity graph). This is context a pure vector search would miss entirely — and it could be life-saving.

### Verification
```bash
npm run test              # All graph + activation tests pass
npm run cli
# Tell it: "I'm vegetarian" and "I'm allergic to peanuts"
# Ask: "What should I cook tonight?"
# Expected: Response references BOTH vegetarian AND peanut allergy
# /graph peanuts → shows connection to dietary_restrictions category
```

---

---

# Phase 6: Consolidation (The Sleep Pass)

**Goal:** Repeated episodic memories are clustered and abstracted into rich semantic summaries. Five mentions of a hackathon become one narrative. The memory system can also detect procedural patterns ("user always asks for code examples").

**Duration:** Days 13–15

### What You Build

```
src/
├── processes/
│   ├── consolidation.ts      # NEW — Cluster + abstract + retire
│   └── procedural.ts         # NEW — Pattern detection for procedural memories
└── agent.ts                  # UPDATE — Schedule consolidation runs
```

### Tasks

#### 6.1 Cluster Detection (`src/processes/consolidation.ts`)
- [ ] `findConsolidationCandidates(userId)`:
  1. Fetch all active episodic memories
  2. Compute pairwise cosine similarity
  3. Group memories with similarity > 0.70 that share at least one entity
  4. Only process clusters with 3+ memories (don't consolidate pairs)
  5. Return clusters as arrays of memory IDs

#### 6.2 Abstractive Summarization
- [ ] For each cluster, call the LLM:
  ```
  You are consolidating multiple episodic memories into a single semantic memory.
  
  Memories (in chronological order):
  1. [Day 1] "Started working on the hackathon project"
  2. [Day 3] "Debugging the memory decay function"
  3. [Day 8] "Finally got consolidation working"
  4. [Day 12] "Benchmark results look promising"
  5. [Day 14] "Submitted the hackathon project"
  
  Create ONE semantic summary that captures:
  - The core fact or pattern
  - The narrative arc (beginning → middle → end, if applicable)
  - The emotional trajectory
  - Key details worth preserving
  - The time span
  
  Return JSON:
  {
    "summary": "...",
    "importance": 0.0-1.0,
    "emotional_weight": 0.0-1.0,
    "entities": [{ "name": "...", "type": "...", "relation": "..." }]
  }
  ```

#### 6.3 Memory Retirement
- [ ] After consolidation:
  1. Create a new semantic memory from the LLM's summary
  2. Importance = max(importance of source memories, LLM's suggested importance)
  3. Emotional weight = max(emotional weights of sources)
  4. Link the new memory to the same entities as the sources
  5. Mark all source episodic memories as `status: "consolidated"`
  6. Record the consolidation in the `consolidations` table
  7. Set new memory's `consolidated_from` to the list of source IDs

#### 6.4 Consolidation Scheduling
- [ ] Add consolidation trigger to the agent loop:
  - Run after every N turns (configurable, default: 20 turns)
  - Or when manually triggered via CLI
  - Or on a time-based schedule (every 6 simulated hours)
- [ ] Consolidation is non-blocking — runs async after the response is sent

#### 6.5 Procedural Memory Detection (`src/processes/procedural.ts`)
- [ ] `detectProceduralPatterns(userId)`:
  1. Analyze conversation history for repeated behavioral patterns
  2. Send a batch of recent conversations to the LLM:
     ```
     Analyze these conversation excerpts and identify any consistent 
     behavioral patterns or preferences in how the user communicates:
     
     [conversation excerpts]
     
     Return patterns like:
     - "User prefers concise answers over detailed explanations"
     - "User always asks for Python code examples"
     - "User gets frustrated when asked clarifying questions"
     ```
  3. Store detected patterns as procedural memories
  4. Deduplicate against existing procedural memories
- [ ] Run procedural detection less frequently (every 50 turns or daily)

#### 6.6 CLI Updates
- [ ] Add `/consolidate` command — manually trigger a consolidation pass:
  ```
  🧠 Consolidation Pass Results:
  Found 2 clusters:
    Cluster 1: 5 memories about "hackathon project" → Consolidated into 1 semantic memory
    Cluster 2: 3 memories about "morning routine" → Consolidated into 1 semantic memory
  Retired: 8 episodic memories
  Created: 2 semantic memories
  ```
- [ ] Add `/procedural` command — show detected behavioral patterns

#### 6.7 Tests
- [ ] Test cluster detection: 5 related episodic memories → 1 cluster
- [ ] Test that unrelated memories are NOT clustered
- [ ] Test abstractive summary quality: output should be a coherent narrative, not a concatenation
- [ ] Test retirement: source memories marked as "consolidated" and excluded from recall
- [ ] Test importance inheritance: new semantic memory gets max importance from cluster
- [ ] Test entity inheritance: new memory linked to all entities from source memories
- [ ] Test procedural detection: given 10 conversations where user asks for Python code → pattern detected

### Milestone Deliverable
After 20+ turns of conversation, the system consolidates repetitive episodic memories into rich semantic summaries. "Five mentions of the hackathon" becomes one narrative: "User completed a two-week hackathon building a memory system, progressing through development challenges to successful submission." The memory database stays lean and focused.

### Verification
```bash
npm run test              # All consolidation tests pass
npm run cli
# Have a 25-turn conversation mentioning a project repeatedly
# /consolidate
# /memories → See the consolidated semantic summary
# Old episodic memories should be marked as consolidated
```

---

---

# Phase 7: Benchmarking, Polish, & Release

**Goal:** Prove that Engram works better than the alternatives with honest, reproducible benchmarks. Polish the project for open-source release.

**Duration:** Days 16–20

### What You Build

```
benchmark/
├── scenarios/
│   ├── 40-day-general.json         # 110+ turns, general conversation
│   ├── contradiction-stress.json   # 50 turns, many fact changes
│   └── emotional-events.json       # 60 turns, varying emotional intensity
├── baselines/
│   ├── naive.ts                    # Store all, recall top-k, never forget
│   ├── sliding-window.ts          # Keep last N memories only
│   └── synapse-style.ts           # Simple exponential decay + clustering
├── metrics.ts                      # All 6 metric calculations
├── judge.ts                        # LLM-as-judge for open-ended quality
├── runner.ts                       # Orchestrate benchmark runs
└── report.ts                       # Generate markdown report with tables

Root files:
├── README.md                       # Polished quick-start with badges
├── CONTRIBUTING.md                 # Contribution guidelines
└── BENCHMARK_RESULTS.md            # Published results
```

### Tasks

#### 7.1 Benchmark Scenarios
- [ ] **40-Day General Conversation** (110+ turns):
  - Simulates a real user over 40 days
  - Covers: work, hobbies, food, location, relationships, health, daily life
  - Includes ground-truth annotations: for each "test query" turn, a list of expected recalled facts
  - Example turn flow:
    ```
    Day 1:  "Hi! I'm Sarah, I live in Berlin and work as a data scientist at BMW"
    Day 3:  "Just started learning Rust on the side"
    Day 7:  "Had a terrible migraine yesterday, might need to see a doctor"
    Day 14: "Big news — I got offered a job at Stripe! Moving to Lisbon next month"
    Day 21: "Settled in Lisbon now, love the weather"
    Day 30: [TEST QUERY] "What do you know about me?"
            [EXPECTED] Location: Lisbon (NOT Berlin), Job: Stripe (NOT BMW), Learning: Rust, Health: migraines
    ```
- [ ] **Contradiction Stress Test** (50 turns):
  - User changes location 4 times, job 3 times, dietary preferences 2 times
  - Each change is phrased differently (direct statement, indirect mention, casual reference)
  - Tests: Does the system correctly retire old facts at every step?
- [ ] **Emotional Events** (60 turns):
  - Mix of high-emotion (job loss, medical diagnosis, birth of child) and low-emotion (weather, lunch, commute)
  - Tests: After significant time, are emotional memories retained while trivial ones are forgotten?

#### 7.2 Baseline Implementations
- [ ] **Naive Baseline** (`baselines/naive.ts`):
  - Embeds every message
  - Stores in vector DB
  - Retrieves top-k by cosine similarity
  - Never forgets, never consolidates, never detects contradictions
- [ ] **Sliding Window Baseline** (`baselines/sliding-window.ts`):
  - Stores the last 100 memories
  - When limit is reached, oldest memory is deleted
  - Simple but loses long-term knowledge
- [ ] **Synapse-Style Baseline** (`baselines/synapse-style.ts`):
  - Simple exponential decay (fixed half-life, no spaced repetition)
  - Cluster-based consolidation (not abstractive)
  - Cosine similarity contradiction detection (threshold 0.75)
  - Mimics the dev.to article's approach

#### 7.3 Metrics Implementation (`benchmark/metrics.ts`)
- [ ] `computeRecallAtK(retrieved, expected, k)` — What fraction of expected memories were in top-k?
- [ ] `computePrecisionAtK(retrieved, expected, k)` — What fraction of top-k results were relevant?
- [ ] `computeStalenessResistance(retrieved, superseded)` — What fraction of retrieved results contain outdated facts? (lower is better)
- [ ] `computeTokenCost(retrievedContext)` — Token count of the memory context injected into prompts
- [ ] `computeMemoryCount(store)` — Number of active memories
- [ ] `computeRecallLatency(recallFn)` — Wall-clock time for the recall pipeline (ms)

#### 7.4 LLM-as-Judge (`benchmark/judge.ts`)
- [ ] For open-ended queries where "correctness" isn't binary:
  ```
  Given the query, the recalled memories, and the ground truth, score:
  - Relevance (0-10): Are the recalled memories relevant to the query?
  - Completeness (0-10): Are any important facts missing?
  - Freshness (0-10): Are all recalled facts current (not outdated)?
  ```
- [ ] Use a separate LLM call (not the same model being tested) to avoid bias

#### 7.5 Benchmark Runner (`benchmark/runner.ts`)
- [ ] Orchestrate end-to-end benchmark:
  1. For each scenario × each system (Engram + 3 baselines):
     a. Initialize fresh database
     b. Run all conversation turns with simulated time
     c. At each test query turn, measure all 6 metrics
     d. Record results
  2. Run each configuration 3 times (for standard deviation)
  3. Output results as structured JSON
- [ ] Simulated time: each "day" in the scenario advances the clock by 24 hours
- [ ] Progress display: show current scenario, turn count, elapsed time

#### 7.6 Report Generator (`benchmark/report.ts`)
- [ ] Generate `BENCHMARK_RESULTS.md` with:
  - Summary table (all systems × all metrics)
  - Per-scenario breakdown
  - Charts (memory count over time, token cost over time, salience distribution)
  - Failure analysis: specific cases where Engram lost and why
  - Standard deviation for all numbers

#### 7.7 Project Polish
- [ ] Write comprehensive `README.md`:
  - Badges (build status, npm version, license)
  - One-paragraph description
  - "Why not just use a vector database?" section
  - Quick start (3 commands)
  - Architecture diagram
  - Benchmark results summary table
  - Configuration reference
  - API reference (for REST server mode)
- [ ] Write `CONTRIBUTING.md`
- [ ] Add GitHub Actions CI:
  - Run tests on push
  - Run linter
- [ ] Publish to npm as `engram-memory`
- [ ] Create a 2-minute demo video or GIF for the README

#### 7.8 Final Tests
- [ ] Integration test: Run the full 40-day scenario end-to-end with Engram
- [ ] Verify all 6 metrics are computed correctly
- [ ] Verify baseline implementations match their expected behavior
- [ ] Test report generation produces valid markdown

### Milestone Deliverable
A published open-source project with honest benchmark results proving Engram outperforms naive, sliding window, and Synapse-style memory systems on precision, staleness resistance, and token efficiency — with transparent reporting on any metrics where baselines win.

### Verification
```bash
npm run test              # All tests pass
npm run benchmark         # Full benchmark suite runs (may take 1-2 hours)
# Review BENCHMARK_RESULTS.md for honest, complete results
npm publish               # Published to npm
```

---

---

## Timeline Summary

| Phase | Name | Duration | Key Outcome |
|:---:|:---|:---:|:---|
| 1 | The Skeleton & Storage | Days 1–2 | Store & retrieve memories via CLI |
| 2 | Memory Extraction | Days 3–4 | Automatic memory creation from conversations |
| 3 | Decay Engine | Days 5–6 | Memories fade, spaced repetition works |
| 4 | Contradiction Engine | Days 7–9 | Stale facts auto-retired |
| 5 | Entity Graph | Days 10–12 | Associative recall via spreading activation |
| 6 | Consolidation | Days 13–15 | Episodic → semantic abstraction |
| 7 | Benchmarking & Release | Days 16–20 | Proven results, published package |

**Total: ~20 working days (4 weeks)**

Each phase is independently testable and produces a working increment. You can demo the project after any phase and have something meaningful to show.

---

*"The best time to plant a tree was 20 years ago. The second best time is Phase 1, Day 1."*
