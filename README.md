# 🧠 Engram

> **A Cognitive Memory Architecture for AI Agents**  
> *Memories that decay, consolidate, and associate like a human brain — not a static vector dump.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/Tests-24%20Passing-brightgreen)](https://github.com/harsharajkumar-273/ENGRAM)

---

## The Problem: AI Memory Today is Just a Search Index

Almost every "AI memory" system today does the exact same thing:
1. Embed every user message.
2. Dump all embeddings into a vector database.
3. At query time, retrieve the top-$k$ nearest vectors.

### Why this breaks down:
- **It never forgets anything:** After 500 conversations, your database is flooded with stale chit-chat ("*nice weather today*"), duplicate opinions, and noise.
- **It ignores temporal truth:** If you lived in Berlin in 2024 and moved to Lisbon in 2026, both facts remain in the database forever. The model has no idea which is current.
- **It treats trivial chatter the same as life-critical facts:** Telling an assistant "*I had pasta for lunch*" has the exact same mathematical weight as "*I am deathly allergic to peanuts*".
- **Retrieval gets slower, more expensive, and dumber over time.**

---

## The Solution: Cognitive Memory

Engram is grounded in cognitive science and psychology principles:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER CONVERSATION                               │
│   User: "I just moved to Lisbon for a new job at Stripe!"              │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    AUTONOMOUS EXTRACTION & SCORING                      │
│   • Semantic facts vs Episodic events                                  │
│   • Importance scoring (0.0 to 1.0)                                    │
│   • Emotional intensity weighting (1 + E decay multiplier)              │
│   • Semantic deduplication (≥ 0.92 cosine reinforcement)               │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    THE 4-LAYER COGNITIVE HIERARCHY                      │
│                                                                        │
│   [Layer 1: Working Memory]   Buffer of the last ~8 conversation turns  │
│   [Layer 2: Episodic Memory]  Timestamped life events (72h half-life)   │
│   [Layer 3: Semantic Memory]  Stable facts & preferences (720h half-life│
│   [Layer 4: Procedural]       Learned interaction habits (2160h half-lif│
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    DECAY, CONSOLIDATION & RETRIEVAL                     │
│   • Ebbinghaus Forgetting Curves with Spaced Repetition                │
│   • NLI Entailment Contradiction Detection                             │
│   • Entity Graph Spreading Activation (Associative Recall)             │
│   • Abstractive Consolidation Sleep Passes                             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Key Mechanisms

### 1. Spaced Repetition & Adaptive Half-Life
In typical decay systems, memories fade at a fixed rate. In Engram, **each successful recall flattens the forgetting curve**:

$$H(n) = H_0 \times (1 + \alpha)^n$$

- A memory recalled **0 times** has a base half-life of 72 hours.
- A memory recalled **5 times** has an adaptive half-life of **$\approx 547$ hours**.
- Useful memories become nearly permanent; trivial memories naturally fade away.

### 2. Emotional Intensity Multipliers
The human amygdala modulates memory retention based on emotional charge. Engram scores emotional intensity $E \in [0.0, 1.0]$:
- High-emotion events (layoffs, births, medical diagnoses) receive up to a **$2\times$ decay multiplier ($1 + E$)**, surviving significantly longer before requiring reinforcement.

### 3. Semantic Deduplication
When the user mentions a known fact again, Engram doesn't pollute storage with duplicate vectors. It detects cosine similarity $\ge 0.92$, reinforces the existing memory's recall count, and refreshes its timestamp.

### 4. Zero-Dependency Embedded Storage
Built on SQLite with native BLOB storage and pure TypeScript vector similarity math. Single-file portability, zero cloud infrastructure requirements, and zero Docker containers.

---

## Roadmap & Status

| Phase | Milestone | Status |
|:---:|:---|:---:|
| **Phase 1** | **The Skeleton & Storage** (SQLite schema, types, vector math, memory CRUD) | ✅ **Complete** |
| **Phase 2** | **Memory Extraction Pipeline** (LLM extraction, emotional scoring, agent chat loop, dedup) | ✅ **Complete** |
| **Phase 3** | **Decay Engine** (Ebbinghaus salience formula, adaptive half-lives, decay sweep) | 🚧 *In Progress* |
| **Phase 4** | **Contradiction Engine** (NLI-based entailment vs cosine, automatic fact superseding) | 📋 *Planned* |
| **Phase 5** | **Entity Graph & Associative Recall** (Spreading activation across categories) | 📋 *Planned* |
| **Phase 6** | **Abstractive Consolidation** (Sleep pass: clustering episodic $\to$ rich semantic narrative) | 📋 *Planned* |
| **Phase 7** | **Honest Benchmarking** (3 baselines, 3 scenarios, 6 metrics, published results) | 📋 *Planned* |

See [PHASES.md](PHASES.md) for the complete engineering plan and [ENGRAM.md](ENGRAM.md) for the deep architectural specification.

---

## Quick Start

### 1. Clone & Install
```bash
git clone https://github.com/harsharajkumar-273/ENGRAM.git
cd ENGRAM
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```
Edit `.env` and provide your Google Gemini API key:
```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=your-api-key-here
```

### 3. Run the Interactive CLI
```bash
npm run cli
```

---

## Interactive CLI Commands

Once inside `npm run cli`, chat naturally or use slash commands:

| Command | Description |
|:---|:---|
| `<message>` | Natural conversation with Engram (auto-remembers facts & context) |
| `/recall <query>` | Search memories by semantic vector similarity |
| `/memories` | View all active stored memories with importance and recall counts |
| `/stats` | View distribution counts (Active, Dormant, Superseded, Consolidated) |
| `/debug` | Toggle real-time diagnostic logs of extraction and memory injection |
| `/remember <text>` | Manually force-store a memory |
| `/delete <id>` | Delete a specific memory by ID prefix |
| `/clear` | Wipe all memories from the local database |
| `/help` | Show available commands |
| `/quit` | Exit session |

---

## Running Tests

Engram features a comprehensive test suite covering SQLite operations, vector math, memory extraction, emotional scoring, and agent interaction:

```bash
npm run test
```

Build the TypeScript project to `dist/`:
```bash
npm run build
```

---

## Tech Stack

- **Runtime:** Node.js 20+ (ESM)
- **Language:** TypeScript 5.7 (Strict Mode)
- **Storage:** SQLite (`better-sqlite3`) with WAL mode
- **Vectors:** Pure TypeScript Float32Array cosine similarity
- **LLM / Embeddings:** Google Gemini (`gemini-2.0-flash` & `text-embedding-004`)
- **Test Framework:** Vitest

---

## License

[MIT](LICENSE) © [Harsha Raj Kumar](https://github.com/harsharajkumar-273)
