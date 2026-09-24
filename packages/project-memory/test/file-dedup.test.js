import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProject, addMember } from '../src/projects.js';
import { uploadFile, canReadFile } from '../src/files.js';
import { closePool } from '../src/db.js';
import { uniqueName, cleanupProject } from './helpers.js';

const projectIds = [];
let tmpDir;

test('setup: write a shared temp file', async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'project-memory-test-'));
});

// Deduplication used to be keyed only on (project_id, sha256) — Bob
// uploading bytes identical to Alice's PRIVATE file reused her record,
// inheriting her owner_id and (private) visibility. Bob could then find his
// own upload unreadable (canReadFile checks owner_id for private files) and
// Alice's private file metadata leaked into Bob's upload response.
test('identical bytes uploaded privately by two different owners get separate file records', async () => {
  const project = await createProject(uniqueName('dedup-private'), 'alice');
  projectIds.push(project.id);
  await addMember(project.id, 'alice', 'bob', 'editor');

  const filePath = path.join(tmpDir, 'shared.txt');
  await writeFile(filePath, 'identical private content');

  const aliceUpload = await uploadFile(project.id, 'alice', filePath, { visibility: 'private' });
  const bobUpload = await uploadFile(project.id, 'bob', filePath, { visibility: 'private' });

  assert.notEqual(
    aliceUpload.file.id,
    bobUpload.file.id,
    'private uploads from different owners must get separate file records even with identical bytes'
  );
  assert.equal(bobUpload.file.owner_id, 'bob', "bob's upload must be owned by bob, not alice");
  assert.equal(bobUpload.file.visibility, 'private');

  // Storage is still deduplicated at the byte level even though the logical
  // records differ.
  assert.equal(aliceUpload.file.object_key, bobUpload.file.object_key);

  assert.equal(await canReadFile(bobUpload.file.id, 'bob'), true, 'bob can read his own private file');
  assert.equal(
    await canReadFile(bobUpload.file.id, 'alice'),
    false,
    "alice cannot read bob's private file just because the bytes match hers"
  );
});

test('identical bytes uploaded with project visibility still dedup to one shared record', async () => {
  const project = await createProject(uniqueName('dedup-project'), 'alice');
  projectIds.push(project.id);
  await addMember(project.id, 'alice', 'bob', 'editor');

  const filePath = path.join(tmpDir, 'shared-project.txt');
  await writeFile(filePath, 'identical project-visible content');

  const aliceUpload = await uploadFile(project.id, 'alice', filePath, { visibility: 'project' });
  const bobUpload = await uploadFile(project.id, 'bob', filePath, { visibility: 'project' });

  assert.equal(
    aliceUpload.file.id,
    bobUpload.file.id,
    'project-visible uploads with identical bytes should still share one record — anyone in the project can already see it either way'
  );
});

after(async () => {
  for (const id of projectIds) await cleanupProject(id);
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  await closePool();
});
