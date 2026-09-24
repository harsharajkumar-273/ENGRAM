// Administrative/curatorial audit trail — see db/migrations/008_audit_log.sql
// for what this table is (and, just as importantly, what it deliberately
// is NOT: a log of message posts — the messages table already is that).
//
// recordAudit MUST be called with a client that is inside the same
// transaction as the action it's recording, so the audit entry and the
// change it describes commit or roll back together. It never opens its
// own transaction.

export async function recordAudit(client, { projectId, actorId, action, entityType, entityId = null, detail = {} }) {
  if (!projectId) throw new Error('recordAudit requires projectId');
  if (!actorId) throw new Error('recordAudit requires actorId');
  if (!action) throw new Error('recordAudit requires action');
  if (!entityType) throw new Error('recordAudit requires entityType');

  await client.query(
    `INSERT INTO audit_log (project_id, actor_id, action, entity_type, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [projectId, actorId, action, entityType, entityId, JSON.stringify(detail ?? {})]
  );
}

// Raw listing — no visibility filtering. Callers that expose this over an
// API or CLI MUST authorize the caller first (see listAuditLogForUser).
export async function listAuditLog(projectId, { limit = 50, entityType, actorId } = {}) {
  const { query } = await import('./db.js');
  const conditions = ['project_id = $1'];
  const params = [projectId];

  if (entityType) {
    params.push(entityType);
    conditions.push(`entity_type = $${params.length}`);
  }
  if (actorId) {
    params.push(actorId);
    conditions.push(`actor_id = $${params.length}`);
  }

  params.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
  const limitParam = `$${params.length}`;

  const { rows } = await query(
    `SELECT id, project_id, actor_id, action, entity_type, entity_id, detail, created_at
     FROM audit_log
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT ${limitParam}`,
    params
  );
  return rows;
}

// Authorization-checked entry point: only a project member may read the
// project's audit log (same bar as reading the project itself). Import
// is done lazily inside the function body, not at module top-level, so
// that projects.js and audit.js can both import from each other without
// an ESM circular-import evaluation-order problem — verified safe in
// Node as long as the imported binding is only used inside a function
// body, not read at module-evaluation time.
export async function listAuditLogForUser(projectId, actingUserId, opts = {}) {
  const { assertProjectRead } = await import('./projects.js');
  await assertProjectRead(projectId, actingUserId);
  return listAuditLog(projectId, opts);
}
