import { randomUUID } from 'node:crypto';
import { query } from '../src/db.js';

export function uniqueName(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

// Projects CASCADE to project_members/conversations/messages/files/memories/
// memory_evidence (see db/migrations/001_init.sql), so deleting the project
// is enough cleanup for anything a test created underneath it.
export async function cleanupProject(projectId) {
  await query('DELETE FROM projects WHERE id = $1', [projectId]);
}
