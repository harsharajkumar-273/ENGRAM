# 📊 Engram Benchmark Results

> **Automated Empirical Benchmark: Engram vs. Industry Baselines**  
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

## Key Findings

- **100% Staleness Resistance**: While Naive RAG and fixed-decay baselines repeatedly leak retired residences and past employers, Engram's NLI contradiction engine cleanly supersedes outdated memories with zero prompt pollution.
- **Superior Recall (100%)**: Spreading activation traverses entity graphs to surface unmentioned critical constraints (e.g., retrieving peanut allergies for a dinner query even when the query vector has zero semantic overlap with peanuts).
- **Token Efficiency**: Bounded active memory footprint results in a **24% token reduction** compared to sliding-window approaches and cleaner prompt context for downstream LLMs.
