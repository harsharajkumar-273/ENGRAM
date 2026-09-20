# 📊 Engram Benchmark Results

> **Synthetic Fixture: Engram and Simple Baselines**
> Evaluated across a 40-day simulated user lifecycle with 3 career/location changes, critical medical allergies, and temporal decay sweeps.

---

## Summary Scorecard

| System Architecture | Recall@K | Precision@K | Staleness Resistance | Avg. Token Context | Active Memories |
|:---|:---:|:---:|:---:|:---:|:---:|
| **Engram (Cognitive)** | **100.0%** | **77.8%** | **100.0%** | **19 tokens** | **4 items** |
| **Naive RAG (Vector Dump)** | **66.7%** | **16.7%** | **75.0%** | **38 tokens** | **7 items** |
| **Sliding Window (Last 4)** | **100.0%** | **25.0%** | **91.7%** | **45 tokens** | **4 items** |
| **Synapse-Style (Fixed Decay)** | **100.0%** | **25.0%** | **83.3%** | **41 tokens** | **6 items** |

## Adaptive Tiering Benchmark

This controlled workload contains 1,200 memories with 96-dimensional vectors and 100 queries distributed 60% hot, 30% warm, and 10% cold. Flat and tiered systems receive identical vectors and queries.

| System | Recall@5 | Avg. Vector Comparisons | Avg. Latency | Embeddings / Query | Vector Storage | Storage Reduction | Cold Escalation |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Flat full-precision** | **100.0%** | **1200.0** | **3.37 ms** | **1.00** | **450.0 KiB** | **0.0%** | **100.0%** |
| **Adaptive tiered** | **100.0%** | **324.0** | **2.72 ms** | **1.00** | **213.8 KiB** | **52.5%** | **10.0%** |

The vector-comparison count is deterministic. Latency is a single local process measurement and will vary by machine. The controlled vectors establish routing and quantization behavior; they do not establish semantic retrieval quality on natural conversations.

## LongMemEval Compatibility

Run `npm run benchmark:longmem -- path/to/longmemeval_oracle.json` to validate an official LongMemEval file. The checked oracle split contains only evidence sessions, so ENGRAM reports schema compatibility rather than presenting it as a retrieval score. A full answer-quality evaluation additionally requires a configured reader model and the official evaluator.

---

## Metric Definitions

1. **Recall@K (Higher is Better)**: What fraction of ground-truth required facts were present in the retrieved memory window.
2. **Precision@K (Higher is Better)**: What fraction of retrieved context directly pertained to the user's intent.
3. **Staleness Resistance (Higher is Better, 100% = Perfect)**: Measures the system's ability to prevent superseded, outdated facts (e.g. previous job or previous city) from polluting prompt context.
4. **Token Context (Lower is Better)**: Token footprint injected into the LLM prompt.
5. **Active Memories (Lower/Bounded is Better)**: Storage footprint after decay sweeps and contradiction resolution.

---

## Scope and limitations

The first scorecard is a deterministic fixture with seven hand-written memories and three queries. It uses four-dimensional synthetic vectors and supplies contradiction classifications directly. The adaptive benchmark is larger but remains controlled and synthetic. Neither evaluates NLI classification accuracy, real embedding quality, or held-out answer generation. The token column estimates characters divided by four; it is not a model tokenizer or an inference-cost measurement. Interpret these results only within their fixtures; no general superiority is claimed.
