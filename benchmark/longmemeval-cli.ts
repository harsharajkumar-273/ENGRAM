#!/usr/bin/env node
import * as path from 'node:path';
import { inspectLongMemEval } from './longmemeval.js';

const datasetPath = path.resolve(
  process.argv[2] || 'benchmark/data/longmemeval_oracle.json'
);
const report = inspectLongMemEval(datasetPath);
console.log(JSON.stringify({ datasetPath, ...report }, null, 2));
if (report.malformedInstances > 0) process.exitCode = 1;
