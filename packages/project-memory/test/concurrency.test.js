import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../src/projects.js';
import { createConversation, postMessage } from '../src/conversations.js';
import { extractCandidates } from '../src/memory/extract.js';
import { closePool } from '../src/db.js';
import { uniqueName, cleanupProject } from './helpers.js';

const projectIds = [];

async function assertGaplessSequence(convoId, n) {
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => postMessage(convoId, 'alice', { content: `message ${i}` }))
  );
  const sequenceNumbers = results.map((m) => m.sequence_number).sort((a, b) => a - b);
  const expected = Array.from({ length: n }, (_, i) => i + 1);
  assert.deepEqual(
    sequenceNumbers,
    expected,
    'sequence numbers must be exactly 1..N with no duplicates or gaps despite concurrent posts'
  );
}

// postMessage used to fold the MAX+1 computation into the INSERT and retry a
// fixed number of times on a UNIQUE-violation. That's optimistic concurrency
// with no backoff — empirically it failed about 1-in-5 runs at just 20
// concurrent writers (colliding transactions can retry and collide again
// immediately). It now takes a pessimistic row lock (SELECT ... FOR UPDATE
// on the conversation) instead, which serializes writers deterministically.
// Repeating the trial several times, at a higher N than the failure was
// originally observed at, is the point — a single lucky pass proves nothing
// about a race.
test('concurrent postMessage calls get distinct, gapless sequence numbers (repeated trials)', async () => {
  for (let trial = 0; trial < 5; trial++) {
    const project = await createProject(uniqueName(`concurrency-${trial}`), 'alice');
    projectIds.push(project.id);
    const convo = await createConversation(project.id, 'alice', { title: 'Race' });
    await assertGaplessSequence(convo.id, 30);
  }
});

// extractCandidates() now locks the conversation row for its whole batch, so
// two concurrent extraction calls on the SAME conversation must not create
// duplicate proposals for the same source sentence — the fix for the
// duplicate-check-vulnerable-to-concurrent-extraction gap.
test('concurrent extractCandidates calls on the same conversation do not duplicate proposals', async () => {
  const project = await createProject(uniqueName('concurrency-extract'), 'alice');
  projectIds.push(project.id);
  const convo = await createConversation(project.id, 'alice', { title: 'Race extraction' });
  await postMessage(convo.id, 'alice', { content: 'We will use OAuth for third-party authentication.' });

  const [resultsA, resultsB] = await Promise.all([
    extractCandidates(convo.id, 'alice'),
    extractCandidates(convo.id, 'alice'),
  ]);

  const totalCreated = resultsA.length + resultsB.length;
  assert.equal(totalCreated, 1, `exactly one candidate should be created across both concurrent calls, got ${totalCreated}`);
});

after(async () => {
  for (const id of projectIds) await cleanupProject(id);
  await closePool();
});
