# 🧠 ENGRAM

> **A memory engine and ReAct agent for LLM applications.**
> Memories decay unless they're used, get reinforced when they are, are superseded when contradicted, and move between hot, warm, and cold retrieval tiers, instead of piling up as raw vectors. The agent adds tool use, circuit breakers, retries, and step-by-step traces.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/Tests-84%20Passing-brightgreen)](https://github.com/harsharajkumar-273/ENGRAM)

| | |
|---|---|
| **Tiered retrieval** | 73% fewer vector comparisons (324 vs 1,200) and 52.5% less vector storage at equal Recall@5, on a controlled 1,200-memory synthetic workload ([results](BENCHMARK_RESULTS.md)) |
| **Tests** | 84 tests across 14 Vitest suites, including the benchmark harness |
| **Runs offline** | Tests, benchmarks, and the CLI work without an API key; Gemini is used for extraction, contradiction checks, and embeddings when configured |
| **Not yet shown** | Retrieval quality on real conversations. A full LongMemEval run with a reader model is the next step. |

---

## 🤖 Autonomous Agent

Engram ships an autonomous **ReAct agent** (`src/agent/`) that accomplishes multi-step goals by planning, calling tools in a loop, observing results, and self-correcting - with production-style reliability engineering around the loop:

- **ReAct loop** - structured Think → Act → Observe steps, each a schema-validated JSON decision (`chatJSON`), with observations fed back into the trajectory.
- **Circuit breakers** - trips on N consecutive tool/parse failures *and* on a wall-clock timeout; terminal states are `completed`, `failed`, `circuit_broken`, or `max_steps_exceeded`.
- **Self-healing** - on a tool error it reflects and adjusts arguments; on a malformed model response it retries with a corrective message; it never repeats an identical failing call.
- **Structured tracing** - every step is captured (thought, action, observation, isError, per-step latency), with a full `AgentExecutionTrace` (total tool calls, total latency, status).
- **Memory-backed** - before running, it recalls procedural + semantic priors from Engram memory; after a successful multi-tool goal, it **persists the workflow as a procedural memory**, so the agent learns how it solved past goals and reuses that next time.

### Example run

```bash
npm run agent -- "Calculate compound interest on $10,000 at 7% compounded monthly for 5 years and save summary to scratch/investment.txt"
```

```
====================================================
   🧠 Engram Autonomous ReAct Agent Running...
====================================================

Goal: "Calculate compound interest on $10,000 at 7% compounded monthly for 5 years and save summary to scratch/investment.txt"
LLM Provider: gemini-2.0-flash | Active Tools: calculator, file_read, file_write, memory_search, memory_store

💭 [Step 1 Thought] I need to calculate the compound interest using the formula A = P * (1 + r/n)^(n*t). Here P = 10000, r = 0.07, n = 12, t = 5.
🛠️ [Action] calculator({"expression":"10000 * Math.pow(1 + 0.07 / 12, 12 * 5)"})
👁️ [Observation] 14176.252596139902

💭 [Step 2 Thought] The calculation result is 14176.252596139902. Now I will save this investment summary to scratch/investment.txt as requested.
🛠️ [Action] file_write({"path":"scratch/investment.txt","content":"Investment Growth Summary:\n- Principal: $10,000.00\n- Annual Rate: 7.0%\n- Compounding: Monthly (12/yr)\n- Duration: 5 Years\n- Final Future Value: $14,176.25\n- Total Interest Earned: $4,176.25\n"})
👁️ [Observation] Successfully wrote 190 bytes to scratch/investment.txt

💭 [Step 3 Thought] Calculation completed and summary written to scratch/investment.txt. The goal is fully achieved.

🎯 [Final Answer]
The final future value of $10,000 compounded monthly at 7% for 5 years is $14,176.25 (total interest earned: $4,176.25). The summary has been written to scratch/investment.txt.

✔ Execution completed across 3 steps (2 tool calls)
```

---

## Memory model

Engram explores a SQLite memory store with decay, reinforcement, contradiction-state updates, entity associations, and retrieval scoring. These are implemented mechanisms, not evidence of human-like cognition or universally better retrieval.

## Adaptive Memory Fabric

Engram uses progressive hot/warm/cold retrieval instead of searching every memory on every turn:

- **Hot** contains pinned safety constraints and high-utility memories. Its vectors are cached in memory and searched first.
- **Warm** contains durable facts and procedures in the full-precision SQLite vector index. It is searched only when hot evidence is insufficient.
- **Cold** contains low-utility episodes and archival facts in an int8-quantized vector index, using roughly one quarter of the embedding bytes. It is the final fallback rather than a deletion queue.

The full memory remains canonical in SQLite. A separate lightweight tier record holds its compact retrieval cue, access feedback, utility score, and placement, so promotion never creates conflicting copies. Utility combines intrinsic importance, emotional weight, recency, access frequency, observed usefulness, and memory type. Separate promotion and demotion thresholds prevent frequently moving a memory between tiers.

Safety-critical facts such as allergies are pinned in hot memory. All tier selection and search are scoped to a user. A query is embedded once even when retrieval expands through multiple tiers. Applications can inspect tier and vector-storage statistics through `GET /api/stats`, send task outcomes to `POST /api/tiers/feedback`, and trigger maintenance with `POST /api/tiers/rebalance`.

This design follows recurring ideas in current agent-memory work: hierarchical context from MemGPT, progressive just-in-time disclosure from Anthropic's context engineering, temporal validity from Zep, and separation of compact retrieval abstractions from rich memory values from Microsoft Research's Memora. Engram adds deterministic safety pinning, Ebbinghaus salience, contradiction state, and hysteretic promotion/demotion in one local implementation.

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

### 🔄 Contradiction Engine (LLM-judged)
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

We evaluated Engram against three simple baselines across a simulated **40-day user lifecycle** featuring 3 career/location changes, medical allergies, and temporal decay sweeps.

```bash
npm run benchmark
```

### Summary Scorecard

| System Architecture | Recall@K | Precision@K | Staleness Resistance | Avg. Prompt Context | Active Memories |
|:---|:---:|:---:|:---:|:---:|:---:|
| 🧠 **Engram (Cognitive)** | **100.0%** | **77.8%** | **100.0%** | **19 tokens** | **4 items** |
| 🗄️ **Naive RAG (Vector Dump)** | 66.7% | 16.7% | 75.0% | 38 tokens | 7 items |
| 🪟 **Sliding Window (Last 4)** | 100.0% | 25.0% | 91.7% | 45 tokens | 4 items |
| 📉 **Synapse-Style (Fixed Decay)** | 100.0% | 25.0% | 83.3% | 41 tokens | 6 items |

### Adaptive tiering scorecard

The cost-aware benchmark uses 1,200 memories, 96-dimensional vectors, and 100 queries with identical inputs for flat and tiered retrieval.

| System | Recall@5 | Avg. Vector Comparisons | Vector Storage | Cold Escalation |
|:---|:---:|:---:|:---:|:---:|
| Flat full-precision | 100.0% | 1,200 | 450.0 KiB | 100.0% |
| **Adaptive tiered** | **100.0%** | **324** | **213.8 KiB** | **10.0%** |

This fixture shows a 73% reduction in vector comparisons and a 52.5% reduction in embedding storage while preserving Recall@5. It uses controlled synthetic vectors; it does not establish natural-language retrieval superiority. Local timing is reported in [BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md), where it is explicitly treated as machine-dependent.

### What the benchmark establishes

The first scorecard comes from seven hand-written memories, three queries, synthetic four-dimensional embeddings, and supplied contradiction labels. It is a deterministic mechanism demonstration, not an evaluation of NLI accuracy or general RAG quality. Prompt size is estimated as characters divided by four, not measured with a model tokenizer. The official LongMemEval oracle split is supported as a schema compatibility check; a full answer-quality score still requires the non-oracle history, a reader model, and the official evaluator.

## Execution boundaries

The built-in file tools are restricted to their configured working directory, including symlink resolution. Shell execution requires `createDefaultToolRegistry({ allowShell: true })` and is opt-in and runs with the host process permissions. This is not an OS sandbox. Use a separate sandbox for untrusted tasks. A tool deadline bounds how long the caller waits; arbitrary custom-tool side effects may continue after timeout. The shell tool also uses a child-process timeout.

## Roadmap & Status

| Phase | Milestone | Status |
|:---:|:---|:---:|
| **Phase 1** | Skeleton & Storage (SQLite schema, types, vector math, CRUD) | ✅ Complete |
| **Phase 2** | Memory Extraction Pipeline (LLM extraction, emotional scoring, dedup) | ✅ Complete |
| **Phase 3** | Decay Engine (Ebbinghaus salience, adaptive half-lives, decay sweep) | ✅ Complete |
| **Phase 4** | Contradiction Engine (NLI-style entailment vs cosine, automatic superseding) | ✅ Complete |
| **Phase 5** | Entity Graph & Associative Recall (spreading activation across categories) | ✅ Complete |
| **Phase 6** | Abstractive Consolidation (sleep pass: episodic → semantic narrative) | ✅ Complete |
| **Phase 7** | Benchmarking (memory vs. Naive RAG / Sliding Window / fixed-decay baselines) | ✅ Complete - see [BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md) |
| **Phase 8** | **Autonomous ReAct Agent** (tool-use loop, circuit breakers, self-healing, memory-backed) | ✅ Complete |
| **Phase 9** | **Adaptive Memory Fabric** (hot cache, warm full precision, quantized cold index, progressive retrieval) | ✅ Complete |

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

### 3. Run Autonomous Agent or Interactive CLI
```bash
# Run a specific autonomous goal
npm run agent -- "Calculate compound interest on $10,000 at 7% for 5 years"

# Or enter the interactive CLI
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
| `POST` | `/api/tiers/rebalance` | Recompute adaptive hot/warm/cold memory placement |
| `POST` | `/api/tiers/feedback` | Record whether retrieved memories contributed to task success |
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

Engram is backed by **84 automated unit, integration, and benchmark tests** across 14 test suites with Vitest as the test runner:

```bash
# Run all tests
npm run test

# Run benchmark suite against baselines
npm run benchmark

# Compare flat and adaptive tiered retrieval on 1,200 memories
npm run benchmark:adaptive

# Validate an official LongMemEval dataset file
npm run benchmark:longmem -- benchmark/data/longmemeval_oracle.json

# Typecheck and compile TypeScript
npm run typecheck
npm run build
```

---

## Tech Stack & Architecture Highlights

- **Runtime:** Node.js 20+ (Pure ESM)
- **Language:** TypeScript 5.7 (Strict Mode)
- **Agent Loop:** First-principles ReAct state machine with self-healing error reflection and circuit breakers
- **Tool Harness:** Local ToolRegistry with caller deadlines and required-argument checks
- **Database:** SQLite (`better-sqlite3`) with WAL (Write-Ahead Logging) mode
- **Vectors:** Pure TypeScript Float32Array cosine similarity (zero heavy C++ native vector dependencies)
- **Providers:** Google Gemini (`gemini-2.0-flash` & `text-embedding-004`) + Built-in offline fallback
- **HTTP Server:** Native Node.js `http` module with CORS and clean routing
- **Telemetry:** Structured trace spans capturing thoughts, actions, observations, and latencies
- **Test Engine:** Vitest 2.1

---

## License

[MIT](LICENSE) © [Harsha Raj Kumar](https://github.com/harsharajkumar-273)
