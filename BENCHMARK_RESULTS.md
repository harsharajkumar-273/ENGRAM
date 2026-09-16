# 📊 Engram Benchmark Results

> **Synthetic Fixture: Engram and Simple Baselines**
> Evaluated across a 40-day simulated user lifecycle with 3 career/location changes, critical medical allergies, and temporal decay sweeps.

---

## Summary Scorecard

| System Architecture | Recall@K | Precision@K | Staleness Resistance | Avg. Token Context | Active Memories |
|:---|:---:|:---:|:---:|:---:|:---:|
| **Engram (Cognitive)** | **100.0%** | **33.3%** | **100.0%** | **34 tokens** | **4 items** |
| **Naive RAG (Vector Dump)** | **33.3%** | **8.3%** | **75.0%** | **37 tokens** | **7 items** |
| **Sliding Window (Last 4)** | **100.0%** | **25.0%** | **91.7%** | **45 tokens** | **4 items** |
| **Synapse-Style (Fixed Decay)** | **66.7%** | **16.7%** | **83.3%** | **38 tokens** | **6 items** |

---

## Metric Definitions

1. **Recall@K (Higher is Better)**: What fraction of ground-truth required facts were present in the retrieved memory window.
2. **Precision@K (Higher is Better)**: What fraction of retrieved context directly pertained to the user's intent.
3. **Staleness Resistance (Higher is Better, 100% = Perfect)**: Measures the system's ability to prevent superseded, outdated facts (e.g. previous job or previous city) from polluting prompt context.
4. **Token Context (Lower is Better)**: Token footprint injected into the LLM prompt.
5. **Active Memories (Lower/Bounded is Better)**: Storage footprint after decay sweeps and contradiction resolution.

---

## Scope and limitations

This is a deterministic fixture with seven hand-written memories and three queries. It uses four-dimensional synthetic vectors and supplies contradiction classifications directly. It does not evaluate NLI classification accuracy, real embedding quality, or held-out conversation performance. The token column estimates characters divided by four; it is not a model tokenizer or an inference-cost measurement. Interpret the generated table only within this fixture; no general superiority or fixed percentage improvement is claimed.
