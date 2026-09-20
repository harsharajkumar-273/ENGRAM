#!/usr/bin/env node
// ============================================
// Engram Standalone Benchmark CLI
// ============================================

import { runBenchmark } from './runner.js';
import { runAdaptiveBenchmark } from './adaptive-runner.js';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  console.log('\x1b[36m====================================================\x1b[0m');
  console.log('\x1b[36m   🧠 Engram Multi-Week Benchmark Suite Running...   \x1b[0m');
  console.log('\x1b[36m====================================================\x1b[0m\n');

  const start = Date.now();
  const scorecards = await runBenchmark();
  const adaptive = await runAdaptiveBenchmark();
  const elapsed = Date.now() - start;

  console.table(scorecards);
  console.table(adaptive);

  console.log(`\n\x1b[32m✔ Benchmark finished in ${elapsed}ms\x1b[0m\n`);

  // Generate markdown report
  const markdown = `# 📊 Engram Benchmark Results

> **Synthetic Fixture: Engram and Simple Baselines**
> Evaluated across a 40-day simulated user lifecycle with 3 career/location changes, critical medical allergies, and temporal decay sweeps.

---

## Summary Scorecard

| System Architecture | Recall@K | Precision@K | Staleness Resistance | Avg. Token Context | Active Memories |
|:---|:---:|:---:|:---:|:---:|:---:|
${scorecards.map(s => `| **${s.system}** | **${(s.recall * 100).toFixed(1)}%** | **${(s.precision * 100).toFixed(1)}%** | **${(s.stalenessResistance * 100).toFixed(1)}%** | **${s.avgTokenCost} tokens** | **${s.finalActiveCount} items** |`).join('\n')}

## Adaptive Tiering Benchmark

This controlled workload contains 1,200 memories with 96-dimensional vectors and 100 queries distributed 60% hot, 30% warm, and 10% cold. Flat and tiered systems receive identical vectors and queries.

| System | Recall@5 | Avg. Vector Comparisons | Avg. Latency | Embeddings / Query | Vector Storage | Storage Reduction | Cold Escalation |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
${adaptive.map(s => `| **${s.system}** | **${(s.recallAt5 * 100).toFixed(1)}%** | **${s.avgVectorComparisons.toFixed(1)}** | **${s.avgLatencyMs.toFixed(2)} ms** | **${s.embeddingCallsPerQuery.toFixed(2)}** | **${(s.vectorBytes / 1024).toFixed(1)} KiB** | **${(s.storageReduction * 100).toFixed(1)}%** | **${(s.coldEscalationRate * 100).toFixed(1)}%** |`).join('\n')}

The vector-comparison count is deterministic. Latency is a single local process measurement and will vary by machine. The controlled vectors establish routing and quantization behavior; they do not establish semantic retrieval quality on natural conversations.

## LongMemEval Compatibility

Run \`npm run benchmark:longmem -- path/to/longmemeval_oracle.json\` to validate an official LongMemEval file. The checked oracle split contains only evidence sessions, so ENGRAM reports schema compatibility rather than presenting it as a retrieval score. A full answer-quality evaluation additionally requires a configured reader model and the official evaluator.

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
`;

  fs.writeFileSync(path.resolve('BENCHMARK_RESULTS.md'), markdown, 'utf-8');
  console.log('\x1b[32m✔ Written report to BENCHMARK_RESULTS.md\x1b[0m');
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
