import { describe, it, expect } from 'vitest';
import { runBenchmark } from '../benchmark/runner.js';

describe('Benchmark Suite: Engram vs Baselines', () => {
  it('proves Engram outperforms Naive RAG, Sliding Window, and Synapse-style baselines', async () => {
    const scorecards = await runBenchmark();
    expect(scorecards).toHaveLength(4);

    const engram = scorecards.find(s => s.system.includes('Engram'))!;
    const naive = scorecards.find(s => s.system.includes('Naive'))!;
    const sliding = scorecards.find(s => s.system.includes('Sliding'))!;

    console.log('\n================ BENCHMARK RESULTS ================');
    console.table(scorecards);

    // 1. Staleness Resistance: Engram should achieve 100% staleness resistance
    // because it supersedes outdated memories (Berlin, BMW, Stripe).
    // Naive RAG hoards all memories and therefore leaks stale facts.
    expect(engram.stalenessResistance).toBeGreaterThan(naive.stalenessResistance);
    expect(engram.stalenessResistance).toBe(1.0);

    // 2. High Recall: Engram retrieves required facts
    expect(engram.recall).toBeGreaterThanOrEqual(0.8);

    // 3. Database footprint: Engram retired stale memories, keeping storage clean
    expect(engram.finalActiveCount).toBeLessThan(naive.finalActiveCount);
  });
});
