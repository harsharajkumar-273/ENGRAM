import { describe, expect, it } from 'vitest';
import { runAdaptiveBenchmark } from '../benchmark/adaptive-runner.js';
import { inspectLongMemEval } from '../benchmark/longmemeval.js';

describe('Adaptive memory benchmark', () => {
  it('preserves recall while reducing vector work and storage', async () => {
    const [flat, tiered] = await runAdaptiveBenchmark();

    expect(flat.recallAt5).toBe(1);
    expect(tiered.recallAt5).toBe(1);
    expect(tiered.avgVectorComparisons).toBeLessThan(flat.avgVectorComparisons * 0.5);
    expect(tiered.storageReduction).toBeGreaterThan(0.5);
    expect(tiered.embeddingCallsPerQuery).toBe(1);
    expect(tiered.coldEscalationRate).toBeLessThanOrEqual(0.1);
  }, 20_000);

  it('accepts the official LongMemEval schema', () => {
    const report = inspectLongMemEval('tests/fixtures/longmemeval-oracle-sample.json');

    expect(report.instances).toBe(1);
    expect(report.sessions).toBe(1);
    expect(report.evidenceSessions).toBe(1);
    expect(report.malformedInstances).toBe(0);
    expect(report.questionTypes['knowledge-update']).toBe(1);
  });
});
