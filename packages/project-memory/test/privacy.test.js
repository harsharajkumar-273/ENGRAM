import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, addMember } from '../src/projects.js';
import { createConversation, postMessage, listMessages } from '../src/conversations.js';
import { extractCandidates } from '../src/memory/extract.js';
import {
  confirmMemory,
  listMemories,
  getMemoryWithEvidence,
  rejectMemory,
  editMemory,
  deleteMemory,
} from '../src/memory/lifecycle.js';
import { buildContext } from '../src/memory/context.js';
import { query, closePool } from '../src/db.js';
import { uniqueName, cleanupProject } from './helpers.js';

const projectIds = [];

test('non-member is denied read and write everywhere', async () => {
  const project = await createProject(uniqueName('privacy-nonmember'), 'alice');
  projectIds.push(project.id);

  await assert.rejects(() => listMemories(project.id, 'mallory'), /Access denied/);
  await assert.rejects(
    () => createConversation(project.id, 'mallory', { title: 'x' }),
    /Access denied/
  );

  const ctx = await buildContext(project.id, 'mallory', 'anything');
  assert.equal(ctx.denied, true);
});

test('viewer role can read but not write', async () => {
  const project = await createProject(uniqueName('privacy-viewer'), 'alice');
  projectIds.push(project.id);
  await addMember(project.id, 'alice', 'dave', 'viewer');

  const ctx = await buildContext(project.id, 'dave', 'anything');
  assert.equal(ctx.denied, false);
  await assert.doesNotReject(() => listMemories(project.id, 'dave'));

  await assert.rejects(
    () => createConversation(project.id, 'dave', { title: 'x' }),
    /Access denied/
  );
});

test('a read-only conversation ACL grants read but not write', async () => {
  const project = await createProject(uniqueName('privacy-acl'), 'alice');
  projectIds.push(project.id);
  await addMember(project.id, 'alice', 'bob', 'editor');

  const convo = await createConversation(project.id, 'alice', { title: 'Private', visibility: 'private' });
  await query(
    `INSERT INTO conversation_acl (conversation_id, user_id, permission) VALUES ($1, $2, 'read')`,
    [convo.id, 'bob']
  );

  await assert.doesNotReject(() => listMessages(convo.id, 'bob'));
  await assert.rejects(
    () => postMessage(convo.id, 'bob', { content: 'hi' }),
    /Access denied/,
    'a read-only ACL grant must not be enough to post messages'
  );
});

test('a memory whose only evidence is a private conversation is hidden from a non-ACLd member but visible to the owner', async () => {
  const project = await createProject(uniqueName('privacy-evidence'), 'alice');
  projectIds.push(project.id);
  // bob is a project member (editor) but has no ACL entry on alice's private conversation below.
  await addMember(project.id, 'alice', 'bob', 'editor');

  const privateConvo = await createConversation(project.id, 'alice', {
    title: "Alice's private notes",
    visibility: 'private',
  });
  await postMessage(privateConvo.id, 'alice', {
    content: 'We will use OAuth for third-party authentication.',
  });

  const created = await extractCandidates(privateConvo.id, 'alice');
  const decision = created.find((m) => m.memory_type === 'decision');
  assert.ok(decision, 'expected a decision candidate to be extracted');
  await confirmMemory(decision.id, 'alice');

  const ctxBob = await buildContext(project.id, 'bob', 'What did we decide about auth?');
  assert.equal(
    ctxBob.activeMemories.some((m) => m.id === decision.id),
    false,
    'bob (project member without ACL on the private conversation) must not see this memory'
  );

  const ctxAlice = await buildContext(project.id, 'alice', 'What did we decide about auth?');
  assert.equal(
    ctxAlice.activeMemories.some((m) => m.id === decision.id),
    true,
    'alice (the private conversation owner) must still see this memory'
  );

  // The leak wasn't limited to `ask`/buildContext — `memory list` and
  // `memory show` (management commands) returned the memory's content
  // directly, bypassing evidence-visibility filtering entirely.
  const bobsMemories = await listMemories(project.id, 'bob');
  assert.equal(
    bobsMemories.some((m) => m.id === decision.id),
    false,
    'memory list must not surface a memory whose only evidence bob cannot see'
  );

  const bobsView = await getMemoryWithEvidence(decision.id, 'bob');
  assert.equal(bobsView, null, 'memory show must not surface a memory whose only evidence bob cannot see');

  const alicesView = await getMemoryWithEvidence(decision.id, 'alice');
  assert.ok(alicesView, 'memory show must still work for alice, who can see the evidence');
});

// bob has general project WRITE access (editor role) — write-role alone is
// not enough to mutate a memory whose evidence he can't see, even if he
// somehow learns (or guesses) its id. This was a real gap: loadMemoryForWrite
// checked assertProjectWrite but nothing else, so any editor could confirm/
// edit/delete/supersede any memory in the project regardless of whether they
// could ever have seen it through a normal read path.
test('an editor with project write access cannot mutate a memory whose evidence they cannot see', async () => {
  const project = await createProject(uniqueName('privacy-write-gate'), 'alice');
  projectIds.push(project.id);
  await addMember(project.id, 'alice', 'bob', 'editor');

  const privateConvo = await createConversation(project.id, 'alice', {
    title: "Alice's private notes",
    visibility: 'private',
  });
  await postMessage(privateConvo.id, 'alice', { content: 'We must always encrypt data at rest.' });
  const [proposed] = await extractCandidates(privateConvo.id, 'alice');
  assert.ok(proposed, 'expected a requirement candidate to be extracted');

  // Not yet confirmed: bob must not be able to confirm a proposal derived
  // from evidence he cannot see.
  await assert.rejects(
    () => confirmMemory(proposed.id, 'bob'),
    /not found/,
    'bob must not be able to confirm a memory whose evidence he cannot see'
  );

  // alice can, since she can see the evidence (she owns the private conversation).
  const active = await confirmMemory(proposed.id, 'alice');
  assert.equal(active.status, 'active');

  await assert.rejects(() => editMemory(active.id, 'bob', 'tampered content'), /not found/);
  await assert.rejects(() => rejectMemory(active.id, 'bob'), /not found/);
  await assert.rejects(() => deleteMemory(active.id, 'bob'), /not found/);

  // alice retains full control over her own memory.
  const edited = await editMemory(active.id, 'alice', 'We must always encrypt data at rest (edited).');
  assert.equal(edited.content, 'We must always encrypt data at rest (edited).');
});

after(async () => {
  for (const id of projectIds) await cleanupProject(id);
  await closePool();
});
