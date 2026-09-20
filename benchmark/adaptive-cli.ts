#!/usr/bin/env node
import { runAdaptiveBenchmark } from './adaptive-runner.js';

const results = await runAdaptiveBenchmark();
console.table(results.map(result => ({
  system: result.system,
  recallAt5: `${(result.recallAt5 * 100).toFixed(1)}%`,
  avgVectorComparisons: result.avgVectorComparisons.toFixed(1),
  avgLatencyMs: result.avgLatencyMs.toFixed(2),
  embeddingCallsPerQuery: result.embeddingCallsPerQuery.toFixed(2),
  vectorKiB: (result.vectorBytes / 1024).toFixed(1),
  storageReduction: `${(result.storageReduction * 100).toFixed(1)}%`,
  coldEscalationRate: `${(result.coldEscalationRate * 100).toFixed(1)}%`,
  recallByTier: Object.entries(result.recallByTier)
    .map(([tier, recall]) => `${tier}:${(recall * 100).toFixed(0)}%`).join(' '),
})));
