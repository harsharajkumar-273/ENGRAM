# Engram — A Cognitive Memory System for AI Agents

> *An engram is the physical trace a memory leaves in the brain. This project builds the digital equivalent.*

---

## Table of Contents

1. [What Is This?](#what-is-this)
2. [The Problem We're Solving](#the-problem-were-solving)
3. [How Human Memory Actually Works](#how-human-memory-actually-works)
4. [Architecture Overview](#architecture-overview)
5. [The Four Memory Layers](#the-four-memory-layers)
6. [Core Mechanisms](#core-mechanisms)
   - [6.1 Salience & Decay (Ebbinghaus + Spaced Repetition)](#61-salience--decay-ebbinghaus--spaced-repetition)
   - [6.2 Memory Extraction](#62-memory-extraction)
   - [6.3 Emotional Tagging](#63-emotional-tagging)
   - [6.4 Contradiction Detection (NLI-Based)](#64-contradiction-detection-nli-based)
   - [6.5 Abstractive Consolidation](#65-abstractive-consolidation)
   - [6.6 Associative Recall (Spreading Activation)](#66-associative-recall-spreading-activation)
7. [Data Model](#data-model)
8. [Recall Pipeline](#recall-pipeline)
9. [Background Processes](#background-processes)
10. [Tech Stack](#tech-stack)
11. [Project Structure](#project-structure)
12. [Benchmarking Strategy](#benchmarking-strategy)
13. [Prior Art & How We Differ](#prior-art--how-we-differ)
14. [Getting Started](#getting-started)
15. [Roadmap](#roadmap)
16. [FAQ](#faq)

---

## What Is This?

Engram is an AI memory system that behaves like a human brain, not a search engine.

Most "AI memory" solutions do the same thing: embed every message into vectors, dump them in a database, and retrieve the top-k most similar chunks at query time. That's not memory. That's a search index. It never forgets anything, it treats "nice weather today" with the same weight as "I'm allergic to penicillin," and it gets slower and noisier the longer it runs.

Engram is different. It:

- **Forgets on purpose.** Unimportant and outdated memories decay over time, just like in a human brain.
- **Remembers what matters.** Memories that are recalled frequently become *harder* to forget (spaced repetition), not just temporarily boosted.
- **Detects contradictions.** When you say "I live in Berlin" and three weeks later say "I just moved to Lisbon," Engram retires the stale fact automatically.
- **Associates memories.** Asking "what should I eat?" pulls in "user is vegetarian" *and* "user is allergic to peanuts" through entity graph connections, even though "peanut allergy" has low cosine similarity to "dinner."
- **Feels emotional weight.** "I got fired today" is remembered far longer than "had pasta for dinner."
- **Abstracts over time.** Five separate mentions of a hackathon project consolidate into one rich narrative summary, not a blob of merged text.

The result is an AI that has a coherent, evolving understanding of who you are — one that grows sharper with use instead of drowning in noise.

---

## The Problem We're Solving

### The Current State of AI Memory

Every major AI memory solution (Mem0, Zep, MemGPT, LangChain Memory) follows the same basic pattern:

```
User says something → Embed it → Store the vector → At query time, find top-k similar vectors → Inject into context
```

This approach has three fundamental flaws:

**1. It never forgets.**
After 1,000 conversations, you have 1,000 conversations worth of vectors. Every retrieval query now searches through years of noise. "What's my favorite color?" might return 47 slightly-relevant chunks from different time periods, some contradicting each other.

**2. It can't distinguish importance.**
"Nice weather today" and "I'm deathly allergic to shellfish" are both embedded and stored identically. The system has no concept of which memories are *critical* and which are *trivial*.

**3. It doesn't handle change.**
When your preferences, location, job, or relationships change, the old facts remain in the database forever. The system might confidently tell you about a job you left two years ago because that memory is still in the top-k results.

### What We Want Instead

A memory system that:
- Prioritizes *important* information over trivial chatter
- Lets outdated information naturally fade away
- Detects when new facts contradict old ones and resolves the conflict
- Gets *faster and more relevant* over time, not slower and noisier
- Recalls related information through association, not just direct similarity

---

## How Human Memory Actually Works

Engram's design is grounded in cognitive science. Here's a simplified model of how human memory operates, and how each property maps to our system:

### The Ebbinghaus Forgetting Curve (1885)

Hermann Ebbinghaus discovered that newly learned information is forgotten at an exponential rate — roughly 50% within an hour, 70% within 24 hours. But there's a crucial insight: **each time you successfully recall something, the forgetting curve flattens.** The memory becomes harder to forget.

This is the foundation of spaced repetition systems (Anki, SuperMemo). Engram uses the same principle: each time a memory is accessed during retrieval, its half-life increases, making it more durable.

### Memory Consolidation (Sleep Research)

During sleep, the brain doesn't just "rest" — it actively reorganizes memories:
- **Episodic memories** (specific events) are replayed and either strengthened or discarded.
- Repeated episodic patterns are **abstracted** into **semantic memories** (general knowledge).
- Contradictory memories are resolved.

Engram runs a periodic "consolidation pass" that mirrors this process: clustering related episodic memories, abstracting them into semantic knowledge, and detecting contradictions.

### Spreading Activation (Collins & Loftus, 1975)

When you think of "doctor," related concepts like "hospital," "medicine," and "nurse" become more accessible in your mind. This is called spreading activation — activating one node in your semantic network partially activates neighboring nodes.

Engram implements this through an entity graph. When a memory is recalled, activation spreads to memories that share entities or concepts, surfacing contextually relevant information that a pure vector search would miss.

### Emotional Enhancement (Amygdala-Hippocampus Interaction)

Emotionally charged events are remembered more vividly and for longer than neutral events. This is because the amygdala modulates hippocampal memory consolidation.

Engram scores the emotional intensity of each memory and uses it as a multiplier in the salience calculation, ensuring that emotionally significant memories decay much more slowly.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER CONVERSATION                              │
│                                                                        │
│   User: "I just moved from Berlin to Lisbon for a new job at Stripe"  │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    LAYER 1: WORKING MEMORY                             │
│                                                                        │
│   • Holds the last ~7 conversation turns                               │
│   • Tracks current topic, active entities, and user intent             │
│   • Ephemeral — cleared when conversation ends                        │
│   • Feeds into memory extraction pipeline                              │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │ Memory Extraction (LLM-scored)
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    LAYER 2: EPISODIC MEMORY                            │
│                                                                        │
│   • Timestamped events: "User moved to Lisbon on Sept 7, 2026"       │
│   • Each memory has:                                                   │
│     - Importance score (0.0–1.0, LLM-judged)                         │
│     - Emotional weight (0.0–1.0, LLM-judged)                         │
│     - Salience (computed from decay formula)                           │
│     - Recall count & last recall time                                  │
│     - Entity links (person, place, organization, topic)               │
│   • Base half-life: 72 hours (decays fast unless reinforced)          │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │ Consolidation Pass (periodic)
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    LAYER 3: SEMANTIC MEMORY                            │
│                                                                        │
│   • Stable facts: "User lives in Lisbon. Works at Stripe."            │
│   • Abstracted from repeated episodic patterns                         │
│   • Base half-life: 720 hours (30 days) — very durable                │
│   • Updated when contradictions are detected                           │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │ Pattern Detection (periodic)
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    LAYER 4: PROCEDURAL MEMORY                          │
│                                                                        │
│   • Learned interaction patterns:                                      │
│     - "User prefers concise answers"                                  │
│     - "User asks for code examples in Python"                         │
│     - "User gets frustrated when given overly long explanations"      │
│   • Derived from observing communication patterns over time            │
│   • Very long half-life: 2160 hours (90 days)                         │
└─────────────────────────────────────────────────────────────────────────┘

                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       ENTITY GRAPH                                     │
│                                                                        │
│   Memories are connected through shared entities:                      │
│                                                                        │
│   [User] ──lives_in──> [Lisbon]                                       │
│   [User] ──works_at──> [Stripe]                                       │
│   [User] ──has_diet──> [Vegetarian]                                   │
│   [User] ──allergic_to──> [Peanuts]                                   │
│   [Vegetarian] ──category──> [Dietary Restrictions]                   │
│   [Peanuts] ──category──> [Dietary Restrictions]                      │
│                                                                        │
│   When "Vegetarian" is recalled for a dinner question,                │
│   spreading activation also surfaces "Peanuts" through                │
│   the shared "Dietary Restrictions" category.                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## The Four Memory Layers

### Layer 1: Working Memory (Buffer)

**Analogy:** What you're holding in your head right now during this conversation.

- Contains the last ~7 conversation turns (inspired by Miller's Law — humans hold 7 plus or minus 2 items in working memory).
- Tracks the current topic, active entities, and conversational intent.
- Completely ephemeral — wiped when the conversation session ends.
- Purpose: Provides immediate context for the current turn and feeds the memory extraction pipeline.

### Layer 2: Episodic Memory

**Analogy:** "I remember that on Tuesday, I told the chatbot I was moving to Lisbon."

- Stores specific, timestamped events from conversations.
- Each memory is individually scored for importance and emotional weight.
- Decays relatively quickly (base half-life: 72 hours) unless reinforced through recall.
- This is where most new memories start their life.

### Layer 3: Semantic Memory

**Analogy:** "I know that I live in Lisbon and work at Stripe."

- Stores stable facts, preferences, and general knowledge about the user.
- Created through two paths:
  1. Direct extraction (user explicitly states a fact: "I'm vegetarian")
  2. Consolidation of repeated episodic memories (5 mentions of liking coffee → "User drinks coffee regularly")
- Decays very slowly (base half-life: 720 hours / 30 days).
- Updated via contradiction detection when facts change.

### Layer 4: Procedural Memory

**Analogy:** "I know how to ride a bike" — you don't remember learning it, but the pattern is internalized.

- Stores learned interaction patterns and user preferences.
- Examples:
  - "User prefers bullet points over paragraphs"
  - "User typically asks follow-up questions about implementation details"
  - "User responds well to analogies"
- Derived automatically by analyzing communication patterns across many conversations.
- Extremely durable (base half-life: 2160 hours / 90 days).

---

## Core Mechanisms

### 6.1 Salience & Decay (Ebbinghaus + Spaced Repetition)

Every memory has a **salience score** that determines its priority during recall. Salience changes over time based on the following formula:

```
S(t) = I × recall_boost(n) × decay(Δt, n) × emotional_multiplier(E)
```

Where:

| Symbol | Name | Description |
|:---|:---|:---|
| `I` | Importance | LLM-scored at write time (0.0–1.0). Measures how decision-relevant, specific, and explicit the memory is. |
| `n` | Recall count | How many times this memory has been successfully retrieved. |
| `recall_boost(n)` | Recall boost | `1 + ln(1 + n)` — logarithmic boost from repeated access. |
| `Δt` | Time elapsed | Hours since the memory was last recalled (or created, if never recalled). |
| `H(n)` | Adaptive half-life | `H₀ × (1 + α)^n` — the half-life *grows* with each recall. |
| `decay(Δt, n)` | Decay factor | `exp(-ln(2) / H(n) × Δt)` — exponential decay with adaptive half-life. |
| `E` | Emotional weight | LLM-scored at write time (0.0–1.0). |
| `emotional_multiplier(E)` | Emotional multiplier | `1 + E` — emotionally charged memories decay up to 2x slower. |

#### The Key Insight: Adaptive Half-Life

This is what separates Engram from every other memory system.

In a simple exponential decay system (like Synapse), a memory's half-life is fixed. Whether you recall it 0 times or 100 times, it decays at the same rate — only the initial "boost" changes.

In Engram, **each successful recall increases the half-life itself**:

```
Memory recalled 0 times:  H = 72 hours
Memory recalled 1 time:   H = 72 × 1.5^1  = 108 hours
Memory recalled 3 times:  H = 72 × 1.5^3  = 243 hours
Memory recalled 5 times:  H = 72 × 1.5^5  = 547 hours
Memory recalled 10 times: H = 72 × 1.5^10 = 4,153 hours (~173 days)
```

A memory that has proven useful (by being recalled many times) becomes nearly permanent. A memory that was never recalled fades within days. This is exactly how spaced repetition works in human cognition.

#### Base Half-Lives by Memory Type

| Memory Type | Base Half-Life (H₀) | Rationale |
|:---|:---|:---|
| Episodic | 72 hours (3 days) | Event details fade quickly without reinforcement |
| Semantic | 720 hours (30 days) | Facts are more stable but can still become outdated |
| Procedural | 2,160 hours (90 days) | Behavioral patterns change slowly |

#### Pruning Threshold

When a memory's salience drops below **0.01**, it is marked as "dormant." Dormant memories are excluded from retrieval but retained in storage for a grace period (7 days) before permanent deletion. This allows for recovery if the memory is unexpectedly relevant again.

---

### 6.2 Memory Extraction

When a user sends a message, the extraction pipeline identifies memories worth storing.

**Input:** A conversation turn (user message + assistant response + context).

**Process:** An LLM call with structured output extracts zero or more memories:

```json
{
  "memories": [
    {
      "content": "User moved from Berlin to Lisbon",
      "type": "episodic",
      "importance": 0.85,
      "emotional_weight": 0.60,
      "entities": [
        { "name": "Berlin", "type": "location" },
        { "name": "Lisbon", "type": "location" },
        { "name": "User", "type": "person" }
      ],
      "reasoning": "Explicit life event with location change — high decision-relevance for future location-based questions"
    },
    {
      "content": "User works at Stripe",
      "type": "semantic",
      "importance": 0.80,
      "emotional_weight": 0.30,
      "entities": [
        { "name": "Stripe", "type": "organization" },
        { "name": "User", "type": "person" }
      ],
      "reasoning": "Explicit employment fact — stable and relevant for professional context"
    }
  ]
}
```

**Extraction criteria** (instructed to the LLM):
- **Extract:** Facts, preferences, decisions, life events, emotional statements, explicit requests to remember.
- **Skip:** Small talk, filler, acknowledgments ("okay", "thanks"), information the AI already stated (not user-originated).

**Deduplication:** Before storing, the extracted memory is compared against existing memories using vector similarity. If a near-duplicate exists (cosine similarity > 0.92), the existing memory's recall count is incremented instead of creating a new entry.

---

### 6.3 Emotional Tagging

At extraction time, the LLM also scores the **emotional intensity** of each memory on a 0.0–1.0 scale.

**Scoring rubric provided to the LLM:**

| Score Range | Meaning | Examples |
|:---|:---|:---|
| 0.0 – 0.1 | Completely neutral / mundane | "Had coffee this morning" |
| 0.2 – 0.4 | Mild interest or preference | "I've been thinking about learning Rust" |
| 0.5 – 0.7 | Significant personal relevance | "Starting a new job next week", "Broke up with my partner" |
| 0.8 – 1.0 | Deeply emotional / life-changing | "I got diagnosed with...", "We're having a baby", "I got fired" |

**Effect on memory:** A memory with emotional weight 0.9 decays at roughly half the rate of a neutral memory (multiplier of 1.9 vs. 1.0). This means emotionally charged memories persist for roughly twice as long before needing reinforcement.

---

### 6.4 Contradiction Detection (NLI-Based)

This is one of Engram's most important mechanisms and a major improvement over prior work.

#### The Problem with Cosine Similarity for Contradictions

Most systems (including Synapse) use cosine similarity between embeddings to detect contradictions. This fails badly because contradictions are often semantically distant:

| Memory A | Memory B | Cosine Similarity | Actually Contradicts? |
|:---|:---|:---:|:---:|
| "I live in Berlin" | "I just moved to Lisbon" | ~0.59 | **Yes** |
| "I'm vegetarian" | "I had the best steak last night" | ~0.31 | **Yes** |
| "I work at Google" | "I started at Stripe last month" | ~0.45 | **Yes** |
| "I like Python" | "I prefer Python over Java" | ~0.82 | **No** (refinement) |

A cosine similarity threshold (Synapse uses 0.75) would miss the first three genuine contradictions entirely.

#### Engram's Approach: Natural Language Inference (NLI)

Instead of comparing embeddings, Engram uses a two-stage contradiction detection pipeline:

**Stage 1: Candidate Selection (Fast)**
When a new memory is stored, we retrieve the top-20 most similar existing memories using vector search. This is a broad net — we intentionally use a low similarity threshold (0.3) to catch semantically distant contradictions.

**Stage 2: Entailment Classification (Precise)**
For each candidate pair, we run an NLI classification:

```
Given:
  Premise:    "User lives in Berlin"
  Hypothesis: "User just moved to Lisbon"

Classify as:
  ENTAILMENT    → Hypothesis follows from premise (compatible)
  CONTRADICTION → Hypothesis conflicts with premise (incompatible)
  NEUTRAL       → No clear logical relationship
```

This can be done by:
1. **An LLM call** (most accurate, higher latency)
2. **A lightweight NLI model** like `cross-encoder/nli-deberta-v3-base` (fast, runs locally)

**Stage 3: Resolution**
When a contradiction is detected, Engram resolves it by:
1. Comparing timestamps — the newer memory wins.
2. The older, contradicted memory is marked as "superseded" with a reference to the new memory.
3. Superseded memories are excluded from recall but retained for audit purposes.
4. A log entry records the contradiction for transparency.

---

### 6.5 Abstractive Consolidation

Periodically (configurable — default every 6 hours of simulated time, or on-demand), Engram runs a "consolidation pass" that mirrors what the brain does during sleep.

#### Step 1: Cluster Detection

Episodic memories are clustered using embedding similarity. Memories with cosine similarity > 0.70 that share at least one entity are grouped.

#### Step 2: Abstractive Summarization

Each cluster is sent to the LLM with this instruction:

```
You are consolidating multiple episodic memories into a single semantic memory.

Episodic memories:
1. "Started working on the hackathon project" (Day 1)
2. "Debugging the memory decay function" (Day 3)
3. "Finally got consolidation working" (Day 8)
4. "Benchmark results look promising" (Day 12)
5. "Submitted the hackathon project" (Day 14)

Create ONE semantic summary that captures:
- The core fact or pattern
- The overall narrative arc (beginning → middle → end)
- The emotional trajectory (if applicable)
- Key details worth preserving
- The time span
```

**Output:**
```
"User completed a two-week hackathon project building a memory decay and
consolidation system. Progressed from initial development through debugging
challenges to successful submission with promising benchmark results.
Emotional arc: determination → frustration → satisfaction."
```

#### Step 3: Retirement

The original episodic memories are marked as "consolidated" and stop appearing in retrieval. The new semantic memory inherits the highest importance score from the cluster and starts with a recall count of 0.

---

### 6.6 Associative Recall (Spreading Activation)

This is Engram's secret weapon for surfacing contextually relevant memories that pure vector search would miss.

#### The Entity Graph

Every memory is connected to its extracted entities. Entities are also connected to each other through shared categories:

```
Memory: "User is vegetarian"
  └── Entity: "Vegetarian" (type: dietary_preference)
        └── Category: "Dietary Restrictions"

Memory: "User is allergic to peanuts"
  └── Entity: "Peanuts" (type: allergen)
        └── Category: "Dietary Restrictions"

Memory: "User's favorite restaurant is Casa Lisboa"
  └── Entity: "Casa Lisboa" (type: restaurant)
        └── Category: "Dining"
  └── Entity: "Lisbon" (type: location)
```

#### How Spreading Activation Works at Recall Time

1. **Direct Recall:** Vector search + salience ranking returns the top memories for the query.
2. **Entity Extraction:** The entities in the top results are identified.
3. **Activation Spread:** For each entity, we traverse 1 hop in the graph and partially activate connected memories.
4. **Boost and Re-rank:** Connected memories receive a boost proportional to their graph proximity and are merged into the final result set.

**Example:**

```
Query: "What should I cook for dinner tonight?"

Step 1 - Direct Recall:
  → "User is vegetarian" (similarity: 0.72, salience: 0.85)
  → "User enjoys Italian food" (similarity: 0.68, salience: 0.60)

Step 2 - Entity Extraction:
  → Entities found: [Vegetarian, Italian food]

Step 3 - Spreading Activation:
  → "Vegetarian" is in category "Dietary Restrictions"
  → Other memories in "Dietary Restrictions": "User is allergic to peanuts"
  → Activation boost applied to peanut allergy memory

Step 4 - Final Result Set:
  1. "User is vegetarian" (salience: 0.85)
  2. "User enjoys Italian food" (salience: 0.60)
  3. "User is allergic to peanuts" (salience: 0.45, boosted via association)
```

Without spreading activation, the peanut allergy would never surface for a cooking question — its embedding is semantically distant from "dinner." But through the entity graph, it's pulled in via the shared "Dietary Restrictions" category. This could literally be life-saving context.

---

## Data Model

### Memory Record

```typescript
interface Memory {
  // Identity
  id: string;                    // UUID
  type: "episodic" | "semantic" | "procedural";
  status: "active" | "dormant" | "superseded" | "consolidated";

  // Content
  content: string;               // The memory text
  embedding: number[];           // Vector embedding for similarity search
  source_turn_id: string;        // Which conversation turn created this

  // Scoring
  importance: number;            // 0.0–1.0, LLM-judged at creation
  emotional_weight: number;      // 0.0–1.0, LLM-judged at creation

  // Decay & Reinforcement
  recall_count: number;          // How many times retrieved
  base_half_life_hours: number;  // H₀ — depends on memory type
  strengthening_factor: number;  // α — default 0.5
  created_at: string;            // ISO timestamp
  last_recalled_at: string;      // ISO timestamp (or created_at if never recalled)

  // Relationships
  entities: EntityLink[];        // Extracted entities with types
  superseded_by: string | null;  // ID of memory that contradicted this
  consolidated_from: string[];   // IDs of episodic memories (for semantic memories)

  // Metadata
  user_id: string;               // Multi-user support
  session_id: string;            // Which conversation session
}

interface EntityLink {
  entity_id: string;
  entity_name: string;
  entity_type: "person" | "location" | "organization" | "topic"
             | "preference" | "allergen" | "dietary_preference" | "skill"
             | "relationship" | "event" | "product" | "other";
  relation: string;              // e.g., "lives_in", "works_at", "allergic_to"
}

interface Entity {
  id: string;
  name: string;
  type: string;
  categories: string[];          // For spreading activation grouping
  first_seen_at: string;
  last_seen_at: string;
}
```

### SQLite Schema

```sql
-- Core memory storage
CREATE TABLE memories (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL CHECK(type IN ('episodic', 'semantic', 'procedural')),
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active', 'dormant', 'superseded', 'consolidated')),
    content         TEXT NOT NULL,
    importance      REAL NOT NULL DEFAULT 0.5,
    emotional_weight REAL NOT NULL DEFAULT 0.0,
    recall_count    INTEGER NOT NULL DEFAULT 0,
    base_half_life  REAL NOT NULL,
    strength_factor REAL NOT NULL DEFAULT 0.5,
    created_at      TEXT NOT NULL,
    last_recalled_at TEXT NOT NULL,
    superseded_by   TEXT REFERENCES memories(id),
    user_id         TEXT NOT NULL,
    session_id      TEXT NOT NULL
);

-- Vector embeddings (using sqlite-vec extension)
CREATE VIRTUAL TABLE memory_vectors USING vec0(
    id TEXT PRIMARY KEY,
    embedding FLOAT[768]    -- dimension depends on embedding model
);

-- Entity storage
CREATE TABLE entities (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL
);

-- Entity categories for spreading activation
CREATE TABLE entity_categories (
    entity_id   TEXT REFERENCES entities(id),
    category    TEXT NOT NULL,
    PRIMARY KEY (entity_id, category)
);

-- Memory-to-entity links
CREATE TABLE memory_entities (
    memory_id   TEXT REFERENCES memories(id),
    entity_id   TEXT REFERENCES entities(id),
    relation    TEXT NOT NULL,
    PRIMARY KEY (memory_id, entity_id, relation)
);

-- Consolidation history
CREATE TABLE consolidations (
    id              TEXT PRIMARY KEY,
    source_ids      TEXT NOT NULL,   -- JSON array of episodic memory IDs
    result_id       TEXT NOT NULL REFERENCES memories(id),
    created_at      TEXT NOT NULL
);

-- Contradiction log
CREATE TABLE contradictions (
    id              TEXT PRIMARY KEY,
    old_memory_id   TEXT REFERENCES memories(id),
    new_memory_id   TEXT REFERENCES memories(id),
    confidence      REAL NOT NULL,
    reasoning       TEXT NOT NULL,
    detected_at     TEXT NOT NULL
);
```

---

## Recall Pipeline

When the agent needs to recall memories for a query, this pipeline executes:

```
Query: "What dietary restrictions should I know about?"
                    │
                    ▼
    ┌───────────────────────────────┐
    │  Step 1: Embed the Query      │
    │  Generate vector embedding    │
    └───────────────┬───────────────┘
                    │
                    ▼
    ┌───────────────────────────────┐
    │  Step 2: Vector Search        │
    │  Find top-30 similar memories │
    │  (cosine similarity > 0.3)    │
    └───────────────┬───────────────┘
                    │
                    ▼
    ┌───────────────────────────────┐
    │  Step 3: Salience Filter      │
    │  Compute current salience for │
    │  each result. Drop if < 0.01  │
    └───────────────┬───────────────┘
                    │
                    ▼
    ┌───────────────────────────────┐
    │  Step 4: Spreading Activation │
    │  Extract entities from top    │
    │  results. Find connected      │
    │  memories via entity graph.   │
    │  Boost their scores.          │
    └───────────────┬───────────────┘
                    │
                    ▼
    ┌───────────────────────────────┐
    │  Step 5: Re-rank              │
    │  Combined score:              │
    │  0.4 × similarity             │
    │  0.4 × salience               │
    │  0.2 × association_boost      │
    └───────────────┬───────────────┘
                    │
                    ▼
    ┌───────────────────────────────┐
    │  Step 6: Return Top-K         │
    │  Return top 10 memories.      │
    │  Update recall_count and      │
    │  last_recalled_at for each.   │
    └───────────────────────────────┘
```

The recall step (Step 6) is important: by updating `recall_count` and `last_recalled_at`, we trigger the spaced repetition effect. Memories that are frequently useful become harder to forget.

---

## Background Processes

Engram runs three background processes that maintain memory health:

### 1. Decay Sweep (Every Hour)

- Recomputes salience for all active memories.
- Memories with salience < 0.01 are marked as "dormant."
- Dormant memories older than 7 days are permanently deleted.

### 2. Consolidation Pass (Every 6 Hours)

- Clusters related episodic memories using embedding similarity.
- Sends clusters to the LLM for abstractive summarization.
- Creates new semantic memories from the abstractions.
- Retires the source episodic memories.

### 3. Contradiction Scan (On Every New Memory Write)

- When a new memory is stored, checks for contradictions against the top-20 most similar existing memories using NLI classification.
- Contradicted memories are marked as "superseded."
- The contradiction is logged with reasoning for transparency.

---

## Tech Stack

| Component | Technology | Why |
|:---|:---|:---|
| **Language** | TypeScript | Type safety for complex memory schemas, strong async support, npm ecosystem |
| **Runtime** | Node.js / Bun | Fast startup, excellent for CLI tools |
| **Storage** | SQLite | Zero-config, embedded, portable, single-file database |
| **Vector Search** | `sqlite-vec` extension | Vector similarity search inside SQLite — no external vector DB needed |
| **Embeddings** | Configurable | Gemini `text-embedding-004`, OpenAI `text-embedding-3-small`, or local models via Ollama |
| **LLM** | Configurable | Any model via a provider interface (Gemini, Claude, OpenAI, Ollama) |
| **CLI Framework** | `readline` / `ink` | Interactive terminal chat interface |
| **HTTP Server** | Hono (optional) | Lightweight REST API for embedding Engram in other applications |
| **Testing** | Vitest | Fast, TypeScript-native test runner |

### Why SQLite + sqlite-vec Instead of a Dedicated Vector Database?

1. **Zero configuration.** No Docker containers, no cloud services, no connection strings. `npm install` and you're done.
2. **Single-file portability.** Your entire memory database is one `.db` file. Back it up, share it, or move it by copying a single file.
3. **Transactional safety.** Memory writes, entity links, and vector updates happen in a single atomic transaction. No consistency issues between separate databases.
4. **Good enough performance.** For a personal AI memory system (hundreds to low thousands of memories), sqlite-vec's brute-force search is fast enough. If you need to scale to millions of memories, swap in a dedicated vector DB later — the provider interface makes this easy.

---

## Project Structure

```
engram/
│
├── src/
│   ├── core/
│   │   ├── types.ts                # Memory, Entity, and config type definitions
│   │   ├── salience.ts             # Ebbinghaus decay + spaced repetition math
│   │   ├── extraction.ts           # LLM-based memory extraction from conversations
│   │   └── emotional.ts            # Emotional weight scoring
│   │
│   ├── storage/
│   │   ├── database.ts             # SQLite database initialization and migrations
│   │   ├── memory-store.ts         # CRUD operations for memories
│   │   ├── vector-store.ts         # sqlite-vec embedding storage and search
│   │   └── graph-store.ts          # Entity graph storage and traversal
│   │
│   ├── processes/
│   │   ├── consolidation.ts        # Abstractive consolidation (sleep pass)
│   │   ├── contradiction.ts        # NLI-based contradiction detection & resolution
│   │   └── decay-sweep.ts          # Periodic salience recomputation and pruning
│   │
│   ├── recall/
│   │   ├── retrieval.ts            # Multi-signal recall pipeline
│   │   ├── spreading-activation.ts # Entity graph traversal for associative recall
│   │   └── reranker.ts             # Combined scoring and re-ranking
│   │
│   ├── providers/
│   │   ├── interface.ts            # LLMProvider and EmbeddingProvider interfaces
│   │   ├── gemini.ts               # Google Gemini provider
│   │   ├── openai.ts               # OpenAI provider
│   │   ├── anthropic.ts            # Anthropic Claude provider
│   │   └── ollama.ts               # Local Ollama provider
│   │
│   ├── agent.ts                    # Main agent loop (chat + memory integration)
│   ├── cli.ts                      # Interactive CLI entry point
│   └── server.ts                   # REST API entry point (optional)
│
├── benchmark/
│   ├── scenarios/
│   │   ├── 40-day-conversation.json   # Multi-day simulated conversation (110+ turns)
│   │   ├── contradiction-heavy.json   # Scenario focused on fact changes
│   │   └── emotional-events.json      # Scenario with emotional intensity variation
│   │
│   ├── baselines/
│   │   ├── naive.ts                # Embed everything, retrieve top-k, never forget
│   │   ├── sliding-window.ts       # Keep only the last N memories
│   │   └── synapse-style.ts        # Simple exponential decay + clustering
│   │
│   ├── metrics.ts                  # Recall, precision, staleness resistance, token cost
│   ├── judge.ts                    # LLM-as-judge scoring for open-ended recall quality
│   └── runner.ts                   # Benchmark orchestration and reporting
│
├── tests/
│   ├── salience.test.ts            # Decay math unit tests
│   ├── contradiction.test.ts       # NLI contradiction detection tests
│   ├── consolidation.test.ts       # Abstractive consolidation tests
│   ├── recall.test.ts              # End-to-end recall pipeline tests
│   └── spreading-activation.test.ts # Graph traversal tests
│
├── package.json
├── tsconfig.json
├── ENGRAM.md                       # This document
└── README.md                       # Quick-start guide
```

---

## Benchmarking Strategy

Honest benchmarking is a core principle of this project. We measure what matters and report results transparently — including where we lose.

### Metrics

| Metric | Definition | How We Measure |
|:---|:---|:---|
| **Recall@K** | Of all memories that *should* have been retrieved, how many were in the top-K results? | Ground-truth annotations on benchmark scenarios |
| **Precision@K** | Of the top-K results returned, how many were actually relevant? | LLM-as-judge scoring |
| **Staleness Resistance** | When a fact changes, does the system stop returning the old fact? | Contradiction-heavy benchmark scenario |
| **Memory Count** | How many active memories exist after N conversation turns? | Direct database count |
| **Token Cost / Query** | How many tokens does the recalled memory context consume? | Token counting on retrieval output |
| **Recall Latency** | How long does the full recall pipeline take (in ms)? | Wall-clock timing |

### Baselines

We compare against three baselines, not just one:

1. **Naive:** Embed every message, store everything, retrieve top-k by cosine similarity, never forget anything. This is what most systems do today.
2. **Sliding Window:** Keep only the most recent N memories (e.g., 100). Simple, fast, but loses long-term knowledge.
3. **Synapse-Style:** Simple exponential decay (fixed half-life) + cluster-based consolidation. This is the approach from the dev.to article.

### Benchmark Scenarios

1. **40-Day Conversation (General):** 110+ turns simulating a real user over 40 days. Covers daily life, work, hobbies, preferences, and evolving facts.
2. **Contradiction-Heavy:** 50 turns where the user's location, job, preferences, and relationships change multiple times. Tests staleness resistance.
3. **Emotional Events:** 60 turns mixing mundane conversation with high-emotion events (job loss, medical news, achievements). Tests emotional weighting effectiveness.

### Reporting Standard

All benchmark results will be reported with:
- Raw numbers (not cherry-picked)
- Standard deviation across 3 runs
- Known failure cases and analysis of *why* they failed
- Honest comparison — if a baseline wins on a metric, we say so

---

## Prior Art & How We Differ

| System | What It Does | How Engram Differs |
|:---|:---|:---|
| **Mem0** | Vector store with user/session scoping, basic memory extraction | No decay, no contradiction detection, no emotional weighting, no associative recall |
| **Zep** | Temporal knowledge graph with auto-summarization | Closer to our approach, but no spaced repetition, no NLI-based contradictions, no emotional tagging |
| **MemGPT (Letta)** | Virtual memory paging inspired by OS memory management | Clever framing but focuses on context window management, not cognitive modeling |
| **LangChain Memory** | Conversation buffer, summary buffer, entity memory | Utility-focused, no decay, no consolidation, no associative recall |
| **Synapse (dev.to)** | Exponential decay + consolidation + cosine-based contradictions | Simple decay (no spaced repetition), cosine contradictions miss rephrased facts, no emotional weighting, no graph, single-model |

---

## Getting Started

### Prerequisites

- Node.js 20+ or Bun 1.0+
- An API key for at least one LLM provider (Gemini, OpenAI, Anthropic, or local Ollama)

### Installation

```bash
git clone https://github.com/yourusername/engram.git
cd engram
npm install
```

### Configuration

Create a `.env` file:

```env
# Choose your LLM provider
LLM_PROVIDER=gemini              # gemini | openai | anthropic | ollama
GEMINI_API_KEY=your-key-here     # Required if LLM_PROVIDER=gemini
OPENAI_API_KEY=your-key-here     # Required if LLM_PROVIDER=openai
ANTHROPIC_API_KEY=your-key-here  # Required if LLM_PROVIDER=anthropic
OLLAMA_MODEL=qwen2.5:32b         # Required if LLM_PROVIDER=ollama

# Choose your embedding provider
EMBEDDING_PROVIDER=gemini        # gemini | openai | ollama
EMBEDDING_MODEL=text-embedding-004

# Memory configuration (optional — sensible defaults provided)
EPISODIC_HALF_LIFE_HOURS=72
SEMANTIC_HALF_LIFE_HOURS=720
PROCEDURAL_HALF_LIFE_HOURS=2160
STRENGTHENING_FACTOR=0.5
PRUNING_THRESHOLD=0.01
CONSOLIDATION_INTERVAL_HOURS=6
```

### Running

```bash
# Start the interactive CLI
npm run cli

# Start the REST API server
npm run server

# Run the benchmark suite
npm run benchmark
```

---

## Roadmap

### Phase 1: Foundation (MVP)
- [ ] SQLite database with sqlite-vec
- [ ] Memory extraction pipeline
- [ ] Salience scoring with Ebbinghaus decay + spaced repetition
- [ ] Basic recall (vector search + salience ranking)
- [ ] Interactive CLI chat
- [ ] Single LLM provider (Gemini)

### Phase 2: Intelligence
- [ ] NLI-based contradiction detection
- [ ] Abstractive consolidation (sleep pass)
- [ ] Emotional weight scoring
- [ ] Entity extraction and graph storage
- [ ] Spreading activation recall
- [ ] Multi-provider support (OpenAI, Anthropic, Ollama)

### Phase 3: Benchmarking & Polish
- [ ] Benchmark framework with 3 scenarios
- [ ] 3 baseline implementations
- [ ] Full metrics suite (recall, precision, staleness, tokens, latency)
- [ ] REST API server
- [ ] Published npm package
- [ ] Comprehensive README with benchmark results

### Phase 4: Advanced Features
- [ ] Procedural memory detection
- [ ] Multi-user support
- [ ] Memory export/import (JSON)
- [ ] Web dashboard for memory visualization
- [ ] Plugin system for custom memory types

---

## FAQ

### Q: Why TypeScript and not Python?

Python is the standard for AI/ML projects, and either would work here. We chose TypeScript because:
1. The primary consumers of Engram are developers building AI agents and chatbots, many of whom work in the JS/TS ecosystem.
2. TypeScript's type system provides excellent safety for the complex memory schemas.
3. npm/npx distribution makes installation trivial (`npx engram` to start chatting).
4. SQLite has excellent Node.js bindings (`better-sqlite3`), and `sqlite-vec` works as a loadable extension.

### Q: How does this handle multi-user scenarios?

Every memory is scoped to a `user_id`. The recall pipeline always filters by user. Entity graphs are user-scoped. In a deployed scenario (REST API mode), the user ID is passed with each request.

### Q: What happens if the LLM extraction produces bad results?

The LLM calls for extraction, importance scoring, and emotional weighting use structured output (JSON schema enforcement). If the output fails schema validation, it's retried up to 3 times with explicit shape-correction prompting. If all retries fail, the turn is logged and skipped rather than storing garbage data.

### Q: How much storage does this use?

Very little. Each memory is approximately:
- ~200 bytes for the text content
- ~3KB for a 768-dimensional float32 embedding
- ~100 bytes for metadata

At 1,000 active memories, the database is roughly 3–4 MB. At 10,000 memories, roughly 35 MB. Disk space is not a practical concern.

### Q: Can I use this with Claude Code / Cursor / other coding agents?

Yes — that's a core use case. Engram can run as a REST API that your coding agent calls to store and retrieve user preferences, project context, and coding patterns. The procedural memory layer is particularly useful for learning how a specific developer likes their code structured.

---

## License

MIT

---

*Built with the conviction that AI memory should work like a brain, not a filing cabinet.*
