import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, addMember } from '../src/projects.js';
import { createConversation, postMessage } from '../src/conversations.js';
import { extractCandidates } from '../src/memory/extract.js';
import { confirmMemory, editMemory } from '../src/memory/lifecycle.js';
import { listAuditLogForUser } from '../src/audit.js';
import { closePool } from '../src/db.js';
import { uniqueName, cleanupProject } from './helpers.js';

const projectIds = [];

test('confirming a memory writes an audit entry naming the actor and memory', async () => {
  const project = await createProject(uniqueName('audit-confirm'), 'alice');
  projectIds.push(project.id);
  const convo = await createConversation(project.id, 'alice', { title: 'Planning' });
  await postMessage(convo.id, 'alice', { content: 'We must always require MFA.' });
  const [candidate] = await extractCandidates(convo.id, 'alice');
  assert.ok(candidate, 'extraction should have produced a requirement candidate');

  await confirmMemory(candidate.id, 'alice');

  const entries = await listAuditLogForUser(project.id, 'alice', { entityType: 'memory', actorId: 'alice' });
  const confirmEntry = entries.find((e) => e.action === 'memory_confirmed' && e.entity_id === candidate.id);
  assert.ok(confirmEntry, 'expected a memory_confirmed audit entry for this memory');
  assert.equal(confirmEntry.actor_id, 'alice');
});

test('editing a memory records both the previous and new content in the audit detail', async () => {
  const project = await createProject(uniqueName('audit-edit'), 'alice');
  projectIds.push(project.id);
  const convo = await createConversation(project.id, 'alice', { title: 'Planning' });
  await postMessage(convo.id, 'alice', { content: 'We must always require MFA.' });
  const [candidate] = await extractCandidates(convo.id, 'alice');
  await confirmMemory(candidate.id, 'alice');

  const updated = await editMemory(candidate.id, 'alice', 'We must always require MFA for admin accounts.');
  assert.equal(updated.content, 'We must always require MFA for admin accounts.');

  const entries = await listAuditLogForUser(project.id, 'alice', { entityType: 'memory' });
  const editEntry = entries.find((e) => e.action === 'memory_edited' && e.entity_id === candidate.id);
  assert.ok(editEntry, 'expected a memory_edited audit entry');
  assert.equal(editEntry.detail.previous_content, candidate.content);
  assert.equal(editEntry.detail.new_content, 'We must always require MFA for admin accounts.');
});

test('adding a member writes an audit entry with the target user and role', async () => {
  const project = await createProject(uniqueName('audit-member'), 'alice');
  projectIds.push(project.id);

  await addMember(project.id, 'alice', 'bob', 'editor');

  const entries = await listAuditLogForUser(project.id, 'alice', { entityType: 'member' });
  const memberEntry = entries.find(
    (e) => e.action === 'member_added_or_role_changed' && e.detail.targetUserId === 'bob'
  );
  assert.ok(memberEntry, 'expected a member_added_or_role_changed audit entry for bob');
  assert.equal(memberEntry.detail.role, 'editor');
  assert.equal(memberEntry.actor_id, 'alice');
});

test('a non-member cannot read the project audit log', async () => {
  const project = await createProject(uniqueName('audit-denied'), 'alice');
  projectIds.push(project.id);

  await assert.rejects(
    () => listAuditLogForUser(project.id, 'mallory'),
    /Access denied/,
    'a caller with no membership in the project must be denied, same as any other project read'
  );
});

after(async () => {
  for (const id of projectIds) await cleanupProject(id);
  await closePool();
});
