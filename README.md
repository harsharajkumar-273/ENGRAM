# 🧠 Engram

> **An Autonomous AI Agent with Long-Term Cognitive Memory and Self-Healing Tool Execution**  
> *Memories that decay, consolidate, and associate like a human brain — driving an autonomous ReAct goal-seeking agent.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/Tests-70%20Passing-brightgreen)](https://github.com/harsharajkumar-273/ENGRAM)
[![Architecture: 7/7 Phases](https://img.shields.io/badge/Roadmap-100%25%20Complete-success)](https://github.com/harsharajkumar-273/ENGRAM)

---

## The Problem: AI Memory Today is Just a Search Index

Almost every "AI memory" system today does the exact same thing:
1. Embed every user turn into high-dimensional space.
2. Dump all embeddings indiscriminately into a vector database.
3. At query time, retrieve the top-$k$ nearest cosine vectors and paste them into the LLM prompt.

### Why this fundamentally breaks down:
- **It never forgets anything:** After 500 conversations, your database is clogged with stale chit-chat ("*nice weather today*"), outdated opinions, and noise.
- **It ignores temporal truth (The Staleness Catastrophe):** If you lived in Berlin in 2024 and moved to Lisbon in 2026, both facts remain in the database forever. A vector search retrieves both with nearly identical similarity, leaving the LLM to hallucinate or mix up past and present.
- **It treats trivial chatter the same as life-critical facts:** Telling an assistant "*I had pasta for lunch*" has the exact same mathematical weight as "*I am deathly allergic to peanuts*".
- **Retrieval gets slower, more expensive, and hallucination-prone over time.**

---

## The Solution: Cognitive Memory

Engram is an end-to-end memory engine grounded in **cognitive psychology and neuroscience principles**:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER CONVERSATION                               │
│   User: "I just moved to Lisbon for a new backend role at Stripe!"     │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    AUTONOMOUS EXTRACTION & SCORING                      │
│   • Multi-type classification: Episodic, Semantic, Procedural          │
│   • Importance scoring (0.0 to 1.0) & Emotional intensity (1 + E)      │
│   • Entity graph linking (places, companies, dietary_restrictions)     │
│   • Fast-path filter & Semantic deduplication (≥ 0.92 cosine)          │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    THE 4-LAYER COGNITIVE HIERARCHY                      │
│                                                                        │
│   [Layer 1: Working Memory]   Rolling conversational buffer (~8 turns) │
│   [Layer 2: Episodic Memory]  Timestamped life events (72h half-life)  │
│   [Layer 3: Semantic Memory]  Stable facts & preferences (720h base)   │
│   [Layer 4: Procedural]       Learned habits & styles (2160h base)     │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              CONTINUOUS COGNITIVE LIFECYCLE PROCESSES                   │
│   • Ebbinghaus Forgetting Curves with Spaced Repetition                │
│   • NLI Entailment Contradiction Engine (Temporal Fact Superseding)    │
│   • Entity Graph Spreading Activation (Cross-Category Associative)     │
│   • Sleep Consolidation Passes (Clustering episodic → semantic schema) │
│   • Background Decay Sweep (Automatic dormancy transition & pruning)   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 🤖 Autonomous Goal-Seeking Agent (ReAct + Self-Healing Tools)

Engram isn't just a memory library — it is an **autonomous agent platform** featuring an execution engine with a built-in ReAct loop, tool registry, and self-healing error recovery:

```
[User Goal] ──► [Engram Memory Recall] ──► [ReAct Planning: Think]
                                                     │
                                                     ▼
[Goal Satisfied] ◄── [Reflection] ◄── [Tool Dispatch: Act]
        │                                            │
        ▼                                            ▼
[Procedural Memory Commit]             [Execution: Observe Output / Error]
                                                     │
                                       (On Failure: Self-Heal & Retry)
```

### Key Agent Systems:
1. **First-Principles ReAct Engine (`AutonomousAgent`):**
   - Implements structured iterative cycles of `Think -> Act -> Observe -> Reflect`.
   - Built from first principles in pure TypeScript (~300 lines of clear, auditable code, zero LangChain/CrewAI bloat).
2. **Sandboxed Tool Registry:**
   - `calculator`: Safe mathematical evaluator (rejects code injection, supports compound interest, statistics, Math functions).
   - `file_read` & `file_write`: Safe workspace filesystem interaction with line range controls.
   - `memory_search`: Agent self-reflection into its own Engram cognitive memory store.
   - `memory_store`: Explicitly persist new semantic or procedural facts discovered during goal execution.
   - `shell_exec`: Shell command execution with timeout, output capture, and exit code propagation.
3. **Fault Tolerance & Self-Healing:**
   - When a tool throws an error (e.g. missing file, invalid syntax), the exact stderr and exception are injected into the agent's observation turn.
   - The agent reflects on why the failure occurred, adjusts parameters, or selects an alternative tool instead of crashing.
4. **Hard Circuit Breakers:**
   - Max step limit (default: 10).
   - Consecutive tool error threshold (default: 3 — prevents runaway broken tool loops).
   - Execution timeout protection (default: 60s).
5. **Continuous Cognitive Memory Integration:**
   - **Pre-execution:** Automatically pulls relevant past procedural rules and user constraints into the planning context.
   - **Post-execution:** When a multi-step task completes successfully, the agent synthesizes a **procedural memory** (90-day base half-life) detailing the workflow, reinforcing future execution speed.
6. **OpenTelemetry-Style Tracing:**
   - Full structured traces: `traceId`, `stepNumber`, `thought`, `action`, `observation`, `latencyMs`, `isError`, and `circuitBreakerReason`.

---

## Mathematical Architecture

Engram implements exact mathematical formulations for memory dynamics:

### 1. Spaced Repetition & Adaptive Half-Life
Rather than fixed exponential decay, each successful recall flattens the forgetting curve, modeling human spaced repetition:

$$H(n) = H_0 \cdot (1 + \alpha)^n$$

Where:
- $H_0$ is the base half-life (72h for episodic, 720h for semantic, 2160h for procedural).
- $\alpha$ is the strengthening factor (default: $0.5$).
- $n$ is the cumulative recall count.

| Recalls ($n$) | Episodic Half-Life | Semantic Half-Life | Retention Profile |
|:---:|:---:|:---:|:---|
| **0** | 72 hours (3 days) | 720 hours (30 days) | Fresh memory, rapidly fades without reuse |
| **1** | 108 hours (4.5 days) | 1,080 hours (45 days) | First reinforcement |
| **3** | 243 hours (10.1 days) | 2,430 hours (101 days) | Well-established fact |
| **5** | 546.7 hours (22.8 days) | 5,467.5 hours (227 days) | Long-term stable knowledge |

### 2. Real-Time Salience Computation
At any moment $t$, the salience $S(t)$ is computed deterministically:

$$S(t) = I \times \underbrace{\big(1 + \ln(1 + n)\big)}_{\text{Recall Frequency Boost}} \times \underbrace{\exp\left(-\frac{\ln(2)}{H(n)} \cdot \Delta t\right)}_{\text{Adaptive Ebbinghaus Decay}} \times \underbrace{(1 + E)}_{\text{Emotional Multiplier}}$$

- $I \in [0.01, 1.0]$: LLM-judged intrinsic importance.
- $\Delta t$: Elapsed hours since the last recall event.
- $E \in [0.0, 1.0]$: Emotional weight (e.g. medical allergies, layoffs, weddings receive up to $2\times$ persistence multiplier, mimicking amygdala-hippocampal modulation).

### 3. Multi-Signal Retrieval Scoring
When an agent searches for context, retrieval is never pure cosine similarity. Engram combines three orthogonal signals:

$$\text{Score}(M, Q) = w_{\text{sim}} \cdot \text{sim}(Q, M) + w_{\text{sal}} \cdot S(t) + \text{Boost}_{\text{graph}}(M)$$

- $w_{\text{sim}} = 0.40$: Semantic vector similarity.
- $w_{\text{sal}} = 0.40$: Real-time cognitive salience.
- $\text{Boost}_{\text{graph}} = 0.25$: Spreading activation boost across the entity graph.

---

## Core Engines

### 🔄 NLI Contradiction Engine
When a user reveals a new fact (e.g. *"I stopped eating meat, I'm vegetarian now"*), vector similarity to an old fact (*"I love grilling steak"*) is moderate (~0.4), so naive deduplication ignores it.
Engram routes candidate matches to an **LLM-based Natural Language Inference (NLI)** classifier:
- **`CONTRADICTION`**: The prior memory is immediately marked `status = 'superseded'`, pointing to the new memory ID. Its recall history is transferred, and an entry is added to the SQLite contradiction audit log.
- **`ENTAILMENT`**: The prior memory is reinforced (recall count incremented).
- **`NEUTRAL`**: Both memories coexist independently.

### 🕸️ Entity Graph & Spreading Activation
Engram extracts named entities into an SQLite property graph (`entities`, `entity_categories`, `memory_entities`).
When a query arrives, Engram traverses 1-hop ontological categories (e.g., `allergen` $\leftrightarrow$ `dietary_restrictions` $\leftrightarrow$ `food`).
> **Result:** Asking *"What should we order for dinner tonight?"* successfully surfaces *"User is allergic to peanuts"* even when the query vector has zero keyword or semantic overlap with peanuts.

### 💤 Abstractive Sleep Consolidation
Episodic memories are short-lived fragments (*"User had sushi on Monday"*, *"User ate ramen on Wednesday"*, *"User got poke on Friday"*).
During periodic consolidation sweeps:
1. Connected components are clustered across shared entities and time windows.
2. The LLM synthesizes a concise, high-salience semantic fact (*"User frequently eats Japanese and seafood dishes"*).
3. The source episodic records are marked `status = 'consolidated'` and retired from the active prompt budget.

### 🛠️ Procedural Memory Engine
Engram observes conversational behavior over time to detect repeating interaction patterns, such as coding styles (*"User prefers concise TypeScript without semicolons"*) and explanation preferences (*"User prefers bullet points over prose"*). Procedural memories carry a **90-day base half-life**.

---

## Empirical Benchmark Results

We evaluated Engram against three standard industry baselines across a simulated **40-day user lifecycle** featuring 3 career/location changes, medical allergies, and temporal decay sweeps.

```bash
npm run benchmark
```

### Summary Scorecard

| System Architecture | Recall@K | Precision@K | Staleness Resistance | Avg. Prompt Context | Active Memories |
|:---|:---:|:---:|:---:|:---:|:---:|
| 🧠 **Engram (Cognitive)** | **100.0%** | **33.3%** | **100.0%** | **34 tokens** | **4 items** |
| 🗄️ **Naive RAG (Vector Dump)** | 33.3% | 8.3% | 75.0% | 37 tokens | 7 items |
| 🪟 **Sliding Window (Last 4)** | 100.0% | 25.0% | 91.7% | 45 tokens | 4 items |
| 📉 **Synapse-Style (Fixed Decay)** | 66.7% | 16.7% | 83.3% | 38 tokens | 6 items |

### Key Benchmark Discoveries:
1. **100% Staleness Resistance:** While Naive RAG repeatedly leaks retired residences and past employers into the prompt, Engram's NLI engine supersedes stale facts with zero prompt pollution.
2. **Superior Recall via Spreading Activation:** Surfaces unmentioned critical constraints (e.g., retrieving peanut allergies for dinner queries).
3. **24% Token Context Reduction:** Bounded active memory footprint results in cleaner prompt budgets and reduced LLM inference costs.

---

## Roadmap & Status

| Phase | Milestone | Status |
|:---:|:---|:---:|
| **Phase 1** | **The Skeleton & Storage** (SQLite WAL schema, Float32Array vector store, memory CRUD) | ✅ **Complete** |
| **Phase 2** | **Memory Extraction Pipeline** (LLM extraction, JSON schema validation, fast-path filter) | ✅ **Complete** |
| **Phase 3** | **Decay Engine** (Ebbinghaus salience formula, adaptive half-lives, decay sweep) | ✅ **Complete** |
| **Phase 4** | **Contradiction Engine** (NLI classification, temporal superseding, audit log) | ✅ **Complete** |
| **Phase 5** | **Entity Graph & Associative Recall** (Ontological categories, spreading activation) | ✅ **Complete** |
| **Phase 6** | **Abstractive Consolidation & Procedural** (Clustering sleep passes, habit detection) | ✅ **Complete** |
| **Phase 7** | **Benchmarking Suite & REST Server** (Comparative baselines, HTTP microservice, CLI) | ✅ **Complete** |
| **Autonomous Engine** | **ReAct Loop & Tool Execution** (Self-healing tool registry, circuit breakers, tracing) | ✅ **Complete** |

---

## Quick Start

### 1. Installation
```bash
git clone https://github.com/harsharajkumar-273/ENGRAM.git
cd ENGRAM
npm install
```

### 2. Environment Setup
```bash
cp .env.example .env
```
Add your Google Gemini API key to `.env`:
```env
GEMINI_API_KEY=your-api-key-here
PORT=3000
ENGRAM_DB_PATH=./engram.db
```
*(Note: Engram includes built-in offline fallback providers, allowing the full test suite, benchmarks, and basic CLI to run without an external API key).*

### 3. Run the Interactive CLI
```bash
npm run cli
```

---

## Interactive CLI

```
  ╔══════════════════════════════════════════╗
  ║         🧠 Engram Memory System          ║
  ║    Memories that think like a brain      ║
  ╚══════════════════════════════════════════╝
```

Engram's interactive CLI provides full conversational memory, autonomous goal execution, and diagnostics:

| Command | Description |
|:---|:---|
| `<message>` | Natural chat turn (auto-recalls relevant memories and extracts new facts) |
| `/goal <objective>` | **Launch autonomous ReAct agent with tools, error self-healing & telemetry** |
| `/remember <text>` | Manually store an active semantic memory |
| `/recall <query>` | Multi-signal recall (vector similarity + salience + graph boost) |
| `/memories` | View active memories with real-time salience, half-lives & decay curves |
| `/decay` | Trigger background decay sweep (transitions faded memories to dormant) |
| `/time` | Display current virtual timestamp |
| `/time advance <hrs>` | Fast-forward virtual time to simulate memory fading across weeks |
| `/stats` | View distribution counts (Active, Dormant, Superseded, Consolidated) |
| `/contradictions` | Display the contradiction audit log |
| `/entities` | List all tracked entities in the knowledge graph |
| `/graph <name>` | Inspect an entity node and its 1-hop connected memories |
| `/consolidate` | Trigger an episodic consolidation sleep pass |
| `/procedural` | Run procedural pattern detection across working memory |
| `/debug` | Toggle real-time diagnostic logs of prompt injection and scoring |
| `/clear` | Wipe all memories from the local database |
| `/quit` | Exit session |

---

## REST API Microservice

Engram includes a zero-external-dependency HTTP REST API microservice:

```bash
npm run server
```

Server starts on `http://localhost:3000`.

### Endpoints

| Method | Endpoint | Description |
|:---|:---|:---|
| `GET` | `/api/health` | System status, uptime, virtual time, and provider connectivity |
| `POST` | `/api/agent/run` | **Execute an autonomous goal using tools, ReAct loop & circuit breakers** |
| `POST` | `/api/chat` | Send a user message; returns agent response + recalled memories |
| `POST` | `/api/remember` | Directly persist a memory with custom importance and type |
| `GET` | `/api/recall?q=...` | Multi-signal recall for a query string |
| `GET` | `/api/memories` | List active memories for a user |
| `GET` | `/api/stats` | Retrieve total, active, dormant, and superseded memory counts |
| `GET` | `/api/entities` | List knowledge graph entities and categories |
| `GET` | `/api/contradictions` | Audit log of all detected and resolved contradictions |
| `POST` | `/api/decay` | Execute a background decay sweep and dormant memory purge |
| `POST` | `/api/consolidate` | Run episodic memory consolidation |
| `POST` | `/api/time/advance` | Fast-forward virtual time (body: `{"hours": 72}`) |

#### Example: Run Autonomous Goal
```bash
curl -X POST http://localhost:3000/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{"goal": "Calculate the compound interest on $10,000 at 7% for 5 years"}'
```

#### Example: Chat with Recall
```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "I just adopted a golden retriever named Rusty!"}'
```

---

## Programmatic TypeScript SDK Usage

You can embed the autonomous agent or cognitive memory engine directly into any TypeScript/Node.js application:

```typescript
import {
  EngramAgent,
  initDatabase,
  GeminiLLMProvider,
  GeminiEmbeddingProvider,
  DEFAULT_CONFIG,
} from 'engram';

// 1. Initialize SQLite storage & providers
const db = initDatabase('./my-agent.db');
const llm = new GeminiLLMProvider(process.env.GEMINI_API_KEY!);
const embedder = new GeminiEmbeddingProvider(process.env.GEMINI_API_KEY!);

// 2. Instantiate Engram Agent
const agent = new EngramAgent(db, llm, embedder, DEFAULT_CONFIG);

// 3. Autonomous goal execution with tools & self-healing
const result = await agent.executeGoal(
  "Calculate compound interest on $15,000 at 6% for 4 years and check if I saved any financial preferences"
);
console.log(result.finalAnswer);
console.log("Steps taken:", result.trace.steps.length);
console.log("Total latency:", result.trace.totalLatencyMs, "ms");
```

---

## Verification & Testing

Engram is backed by **70 automated unit and integration tests** across 12 test suites with zero external test runners required:

```bash
# Run all 70 tests
npm run test

# Run benchmark suite against baselines
npm run benchmark

# Typecheck and compile TypeScript
npm run typecheck
npm run build
```

---

## Tech Stack & Architecture Highlights

- **Runtime:** Node.js 20+ (Pure ESM)
- **Language:** TypeScript 5.7 (Strict Mode, 100% type-safe)
- **Agent Loop:** First-principles ReAct state machine with self-healing error reflection and circuit breakers
- **Tool Harness:** Sandboxed ToolRegistry with execution timeouts and parameter schema validation
- **Database:** SQLite (`better-sqlite3`) with WAL (Write-Ahead Logging) mode
- **Vectors:** Pure TypeScript Float32Array cosine similarity (zero heavy C++ native vector dependencies)
- **Providers:** Google Gemini (`gemini-2.0-flash` & `text-embedding-004`) + Built-in offline fallback
- **HTTP Server:** Native Node.js `http` module with CORS and clean routing
- **Telemetry:** Structured trace spans capturing thoughts, actions, observations, and latencies
- **Test Engine:** Vitest 2.1

---

## License

[MIT](LICENSE) © [Harsha Raj Kumar](https://github.com/harsharajkumar-273)
