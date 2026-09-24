import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../src/projects.js';
import { createConversation, postMessage } from '../src/conversations.js';
import { hybridSearch } from '../src/retrieval.js';
import { query, hasEmbeddingColumn, closePool } from '../src/db.js';
import { uniqueName, cleanupProject } from './helpers.js';

// These exercise hybridSearch's vector legs and the mergeVectorLeg dedup fix
// deterministically, without a live embeddings API key: hybridSearch takes
// injectable embedFn/checkEmbeddingAvailable seams specifically for this
// (see retrieval.js), and pgvector columns accept a hand-built vector
// literal directly — nothing here calls a real embeddings provider.
//
// Requires 002_vector.optional.sql AND 007_message_memory_embeddings.optional.sql
// to have actually been applied (i.e. pgvector installed + `npm run migrate`
// run since) — these tests skip themselves via t.skip() if that hasn't
// happened, the same way the rest of the suite treats the vector-search
// prerequisite as optional infrastructure, not a hard requirement to run
// `npm test` at all.

const projectIds = [];
const DIMS = 1536;

function oneHotVector(index) {
  const arr = new Array(DIMS).fill(0);
  arr[index] = 1;
  return arr;
}

function toVectorLiteral(arr) {
  return `[${arr.join(',')}]`;
}

function fakeEmbedReturning(vectorArr) {
  return async (texts) => texts.map(() => vectorArr);
}

test('a memory with zero keyword overlap is still found via its embedding', async (t) => {
  if (!(await hasEmbeddingColumn('memories'))) {
    t.skip('007_message_memory_embeddings.optional.sql not applied — skipping semantic search test');
    return;
  }

  const project = await createProject(uniqueName('vector-memory'), 'alice');
  projectIds.push(project.id);
  const convo = await createConversation(project.id, 'alice', { title: 'X' });
  const msg = await postMessage(convo.id, 'alice', { content: 'The onboarding flow needs a redesign eventually.' });

  const queryVector = oneHotVector(0);
  // Deliberately shares no real words with the search query below, so the
  // keyword/trigram leg has nothing to find it by — only the embedding can.
  const memoryContent = 'Zzyzx flibbertigibbet quux corge.';

  const { rows } = await query(
    `INSERT INTO memories (project_id, conversation_id, owner_id, memory_type, content, status, certainty, embedding)
     VALUES ($1, $2, 'alice', 'fact', $3, 'active', 'confirmed', $4::vector) RETURNING id`,
    [project.id, convo.id, memoryContent, toVectorLiteral(queryVector)]
  );
  const memoryId = rows[0].id;
  await query(
    `INSERT INTO memory_evidence (memory_id, source_type, conversation_id, message_id, quote, evidence_role)
     VALUES ($1, 'message', $2, $3, $4, 'supports')`,
    [memoryId, convo.id, msg.id, memoryContent]
  );

  const result = await hybridSearch(project.id, 'alice', 'completely unrelated search text', {
    embedFn: fakeEmbedReturning(queryVector),
    checkEmbeddingAvailable: () => true,
  });

  assert.ok(
    result.memories.some((m) => m.id === memoryId),
    'a memory with a matching embedding but zero keyword overlap should still be found'
  );
});

test('a message matching both the keyword and vector legs is not duplicated in sources', async (t) => {
  if (!(await hasEmbeddingColumn('messages'))) {
    t.skip('007_message_memory_embeddings.optional.sql not applied — skipping semantic search test');
    return;
  }

  const project = await createProject(uniqueName('vector-dedup'), 'alice');
  projectIds.push(project.id);
  const convo = await createConversation(project.id, 'alice', { title: 'X' });
  const msg = await postMessage(convo.id, 'alice', {
    content: 'We should migrate the search index sometime next quarter.',
  });

  const queryVector = oneHotVector(1);
  await query(`UPDATE messages SET embedding = $1::vector WHERE id = $2`, [
    toVectorLiteral(queryVector),
    msg.id,
  ]);

  // "migrate" and "search" are real keywords shared with the message above,
  // so this also matches the keyword/trigram leg — the point of this test
  // is that mergeVectorLeg collapses the two legs' hit into one row rather
  // than the naive concatenation the earlier version did.
  const result = await hybridSearch(project.id, 'alice', 'migrate the search index', {
    embedFn: fakeEmbedReturning(queryVector),
    checkEmbeddingAvailable: () => true,
  });

  const matches = result.sources.filter((s) => s.kind === 'message' && s.message_id === msg.id);
  assert.equal(matches.length, 1, 'a row matching both legs must appear exactly once, not twice');
});

test('a memory whose embedding is unrelated to the query is not surfaced by the vector leg alone', async (t) => {
  if (!(await hasEmbeddingColumn('memories'))) {
    t.skip('007_message_memory_embeddings.optional.sql not applied — skipping semantic search test');
    return;
  }

  const project = await createProject(uniqueName('vector-nomatch'), 'alice');
  projectIds.push(project.id);
  const convo = await createConversation(project.id, 'alice', { title: 'X' });
  const msg = await postMessage(convo.id, 'alice', { content: 'Unrelated message content.' });

  // Orthogonal one-hot vectors have cosine similarity 0 — this memory's
  // embedding has nothing in common with the query vector used below, and
  // its content shares no keywords either, so it must not appear at all.
  const memoryContent = 'Warblegarble snickfoodle.';
  const { rows } = await query(
    `INSERT INTO memories (project_id, conversation_id, owner_id, memory_type, content, status, certainty, embedding)
     VALUES ($1, $2, 'alice', 'fact', $3, 'active', 'confirmed', $4::vector) RETURNING id`,
    [project.id, convo.id, memoryContent, toVectorLiteral(oneHotVector(5))]
  );
  const memoryId = rows[0].id;
  await query(
    `INSERT INTO memory_evidence (memory_id, source_type, conversation_id, message_id, quote, evidence_role)
     VALUES ($1, 'message', $2, $3, $4, 'supports')`,
    [memoryId, convo.id, msg.id, memoryContent]
  );

  const result = await hybridSearch(project.id, 'alice', 'something else entirely', {
    embedFn: fakeEmbedReturning(oneHotVector(6)),
    checkEmbeddingAvailable: () => true,
  });

  assert.ok(
    !result.memories.some((m) => m.id === memoryId),
    'an unrelated memory must not be surfaced just because the vector leg ran'
  );
});

after(async () => {
  for (const id of projectIds) await cleanupProject(id);
  await closePool();
});
