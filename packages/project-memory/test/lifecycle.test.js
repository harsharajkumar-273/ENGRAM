import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, addMember } from '../src/projects.js';
import { createConversation, postMessage } from '../src/conversations.js';
import { extractCandidates } from '../src/memory/extract.js';
import {
  confirmMemory,
  rejectMemory,
  supersedeMemory,
  getMemoryWithEvidence,
} from '../src/memory/lifecycle.js';
import { closePool } from '../src/db.js';
import { uniqueName, cleanupProject } from './helpers.js';

const projectIds = [];

test('proposed -> active -> superseded chain retains history (not deleted)', async () => {
  const project = await createProject(uniqueName('lifecycle-supersede'), 'alice');
  projectIds.push(project.id);

  const convo1 = await createConversation(project.id, 'alice', { title: 'Launch planning' });
  await postMessage(convo1.id, 'alice', { content: 'The launch date is November 15.' });
  const convo2 = await createConversation(project.id, 'alice', { title: 'Executive Review' });
  await postMessage(convo2.id, 'alice', { content: 'We moved the launch date to December 1.' });

  const c1 = await extractCandidates(convo1.id, 'alice');
  const c2 = await extractCandidates(convo2.id, 'alice');
  const nov15 = c1.find((m) => m.memory_type === 'deadline');
  const dec1 = c2.find((m) => m.memory_type === 'deadline');
  assert.ok(nov15 && dec1);

  await confirmMemory(nov15.id, 'alice');
  await confirmMemory(dec1.id, 'alice');
  const { old, new: replacement } = await supersedeMemory(nov15.id, dec1.id, 'alice');

  assert.equal(old.status, 'superseded');
  assert.equal(replacement.status, 'active');
  assert.equal(replacement.supersedes_memory_id, nov15.id);

  const inspected = await getMemoryWithEvidence(nov15.id, 'alice');
  assert.equal(inspected.status, 'superseded', 'the old memory is retained, not deleted');
});

test('supersede across different projects is rejected', async () => {
  const projectA = await createProject(uniqueName('lifecycle-cross-a'), 'alice');
  const projectB = await createProject(uniqueName('lifecycle-cross-b'), 'alice');
  projectIds.push(projectA.id, projectB.id);

  const convoA = await createConversation(projectA.id, 'alice', { title: 'A' });
  await postMessage(convoA.id, 'alice', { content: 'We will use OAuth for third-party authentication.' });
  const convoB = await createConversation(projectB.id, 'alice', { title: 'B' });
  await postMessage(convoB.id, 'alice', { content: 'We must always require MFA.' });

  const [memA] = await extractCandidates(convoA.id, 'alice');
  const [memB] = await extractCandidates(convoB.id, 'alice');
  await confirmMemory(memA.id, 'alice');
  await confirmMemory(memB.id, 'alice');

  await assert.rejects(
    () => supersedeMemory(memA.id, memB.id, 'alice'),
    /Cannot supersede across projects/
  );
});

test('reject transitions a proposed memory to rejected', async () => {
  const project = await createProject(uniqueName('lifecycle-reject'), 'alice');
  projectIds.push(project.id);
  const convo = await createConversation(project.id, 'alice', { title: 'X' });
  await postMessage(convo.id, 'alice', { content: 'We must always encrypt data at rest.' });
  const [candidate] = await extractCandidates(convo.id, 'alice');
  assert.ok(candidate);

  const rejected = await rejectMemory(candidate.id, 'alice');
  assert.equal(rejected.status, 'rejected');
});

test('only a project owner can add members; a non-owner is denied', async () => {
  const project = await createProject(uniqueName('lifecycle-membership'), 'alice');
  projectIds.push(project.id);
  await addMember(project.id, 'alice', 'bob', 'editor');

  await assert.rejects(
    () => addMember(project.id, 'bob', 'eve', 'editor'),
    /not an owner/
  );

  const added = await addMember(project.id, 'alice', 'eve', 'viewer');
  assert.equal(added.role, 'viewer');
});

after(async () => {
  for (const id of projectIds) await cleanupProject(id);
  await closePool();
});
