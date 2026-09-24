import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../src/projects.js';
import { createConversation, postMessage } from '../src/conversations.js';
import { extractCandidates } from '../src/memory/extract.js';
import { closePool } from '../src/db.js';
import { uniqueName, cleanupProject } from './helpers.js';

const projectIds = [];

test('re-running extraction on the same conversation is idempotent', async () => {
  const project = await createProject(uniqueName('extraction-idempotent'), 'alice');
  projectIds.push(project.id);
  const convo = await createConversation(project.id, 'alice', { title: 'X' });
  await postMessage(convo.id, 'alice', { content: 'We will use OAuth for third-party authentication.' });

  const first = await extractCandidates(convo.id, 'alice');
  assert.equal(first.length, 1);

  const second = await extractCandidates(convo.id, 'alice');
  assert.equal(second.length, 0, 'no duplicate candidates should be created on a second run');
});

test('an open_question is never fabricated into a decision', async () => {
  const project = await createProject(uniqueName('extraction-classify'), 'alice');
  projectIds.push(project.id);
  const convo = await createConversation(project.id, 'alice', { title: 'DB design' });
  await postMessage(convo.id, 'alice', {
    content:
      'We discussed PostgreSQL and DynamoDB. PostgreSQL seems better for the MVP. No final decision yet. We will revisit this next week.',
  });

  const candidates = await extractCandidates(convo.id, 'alice');
  assert.ok(candidates.some((m) => m.memory_type === 'open_question'), 'expected an open_question candidate');
  assert.ok(
    !candidates.some((m) => m.memory_type === 'decision'),
    'must not fabricate a decision from "leaning toward" / "no final decision yet" language'
  );
});

test('abbreviation-aware sentence splitting does not truncate a sentence at "vs."', async () => {
  const project = await createProject(uniqueName('extraction-abbrev'), 'alice');
  projectIds.push(project.id);
  const convo = await createConversation(project.id, 'alice', { title: 'DB design' });
  await postMessage(convo.id, 'alice', {
    content: 'We will use PostgreSQL vs. DynamoDB for the MVP.',
  });

  const candidates = await extractCandidates(convo.id, 'alice');
  const decision = candidates.find((m) => m.memory_type === 'decision');
  assert.ok(decision, 'expected a decision candidate');
  assert.equal(
    decision.content,
    'We will use PostgreSQL vs. DynamoDB for the MVP.',
    'the sentence must not be split/truncated at the abbreviation "vs."'
  );
});

after(async () => {
  for (const id of projectIds) await cleanupProject(id);
  await closePool();
});
