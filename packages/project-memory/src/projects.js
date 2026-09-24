import { query, withTransaction } from './db.js';
import { recordAudit } from './audit.js';

export async function createProject(name, ownerId) {
  if (!name || !ownerId) throw new Error('createProject requires a name and ownerId');
  // Two statements (project + owner membership row) must succeed or fail
  // together — a crash between them would otherwise leave an ownerless,
  // inaccessible project.
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING *`,
      [name, ownerId]
    );
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [rows[0].id, ownerId]
    );
    return rows[0];
  });
}

// Only an existing owner may add or change members — previously this took no
// acting-user parameter at all, so any caller could add themselves (or anyone
// else) to any project.
//
// Wrapped in a transaction so the membership change and its audit entry
// commit or roll back together — not because the single INSERT..ON CONFLICT
// needs one on its own.
export async function addMember(projectId, actingUserId, targetUserId, role = 'editor') {
  await assertProjectOwner(projectId, actingUserId);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [projectId, targetUserId, role]
    );
    // entity_id is null: project_members' key is (project_id, user_id), not
    // a single uuid, so the identifying detail goes in `detail` instead.
    await recordAudit(client, {
      projectId,
      actorId: actingUserId,
      action: 'member_added_or_role_changed',
      entityType: 'member',
      entityId: null,
      detail: { targetUserId, role },
    });
    return rows[0];
  });
}

// Read-only, for the UI's project picker: every project this user is a
// member of (any role), with their role in each so the UI can grey out
// write actions for viewers without a separate round-trip.
export async function listProjectsForUser(userId) {
  const { rows } = await query(
    `SELECT p.*, pm.role AS my_role
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id
     WHERE pm.user_id = $1 AND p.archived_at IS NULL
     ORDER BY p.created_at DESC`,
    [userId]
  );
  return rows;
}

export async function getMemberRole(projectId, userId) {
  const { rows } = await query(
    `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
    [projectId, userId]
  );
  return rows[0]?.role ?? null;
}

export async function isMember(projectId, userId) {
  return (await getMemberRole(projectId, userId)) !== null;
}

// Read-level: any membership role. Every read path (listMemories,
// buildContext's membership check, ...) calls this so permission logic lives
// in one place instead of being re-derived per caller.
export async function assertProjectRead(projectId, userId) {
  if (!(await isMember(projectId, userId))) {
    throw new Error(`Access denied: user "${userId}" is not a member of project ${projectId}`);
  }
}

// Write-level: owner or editor. Viewers are read-only — they cannot create
// conversations, post messages, upload files, or mutate memories.
export async function assertProjectWrite(projectId, userId) {
  const role = await getMemberRole(projectId, userId);
  if (role !== 'owner' && role !== 'editor') {
    throw new Error(`Access denied: user "${userId}" does not have write access to project ${projectId}`);
  }
}

export async function assertProjectOwner(projectId, userId) {
  const role = await getMemberRole(projectId, userId);
  if (role !== 'owner') {
    throw new Error(`Access denied: user "${userId}" is not an owner of project ${projectId}`);
  }
}
