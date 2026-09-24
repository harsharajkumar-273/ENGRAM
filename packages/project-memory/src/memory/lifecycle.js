import { query, withTransaction, hasEmbeddingColumn } from '../db.js';
import { assertProjectRead, assertProjectWrite } from '../projects.js';
import { attachVisibleEvidence, assertMemoryVisible } from '../access.js';
import { embed, embeddingsAvailable } from '../embeddings.js';
import { recordAudit } from '../audit.js';

// Applies the SAME evidence-visibility rule used by buildContext/hybridSearch
// (see access.js): a project-scoped memory's *content* can still be derived
// from a private source the caller can't read, so listing/showing it is a
// leak just as much as surfacing it through `ask` would be. Rather than
// making these management commands owner-only (which would also wrongly
// exclude an editor/viewer who legitimately DOES have read access to the
// source), every read path uses the same rule: if you can't see any of a
// memory's evidence, you don't get the memory.
export async function listMemories(projectId, actingUserId, { status } = {}) {
  await assertProjectRead(projectId, actingUserId);
  const params = [projectId];
  let where = 'project_id = $1 AND deleted_at IS NULL';
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  const { rows } = await query(`SELECT * FROM memories WHERE ${where} ORDER BY created_at`, params);
  return (await attachVisibleEvidence(rows, actingUserId)).filter((m) => m.evidence.length > 0);
}

export async function getMemoryWithEvidence(memoryId, actingUserId) {
  const { rows: mRows } = await query(`SELECT * FROM memories WHERE id = $1`, [memoryId]);
  if (mRows.length === 0) return null;
  await assertProjectRead(mRows[0].project_id, actingUserId);
  const [withEvidence] = await attachVisibleEvidence(mRows, actingUserId);
  // Indistinguishable from "not found" for a caller who legitimately can't
  // see this memory — don't leak its existence or content via a different
  // response shape.
  return withEvidence.evidence.length > 0 ? withEvidence : null;
}

// Every mutation loads the memory first (to find its project) and requires
// BOTH project write access AND evidence visibility. Project write access
// alone is not enough: an editor who has general write access to the
// project but cannot see a private-derived memory's evidence must not be
// able to confirm/edit/delete/supersede it just by knowing (or guessing) its
// id — that was a real gap, since only the read paths (listMemories,
// getMemoryWithEvidence) were checking visibility, not the write paths.
//
// Uses the pooled `query`, not a transaction client — this is a pre-check
// that runs before a mutation's own transaction opens (same pattern as
// addMember's assertProjectOwner check in projects.js), not part of the
// mutation itself.
async function loadMemoryForWrite(memoryId, actingUserId) {
  const { rows } = await query(`SELECT * FROM memories WHERE id = $1`, [memoryId]);
  if (rows.length === 0) throw new Error(`Memory ${memoryId} not found`);
  await assertProjectWrite(rows[0].project_id, actingUserId);
  await assertMemoryVisible(rows[0], actingUserId);
  return rows[0];
}

export async function confirmMemory(memoryId, actingUserId) {
  const existing = await loadMemoryForWrite(memoryId, actingUserId);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE memories SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'proposed' RETURNING *`,
      [memoryId]
    );
    if (rows.length === 0) {
      throw new Error(`Memory ${memoryId} not found or not in 'proposed' state`);
    }
    await recordAudit(client, {
      projectId: existing.project_id,
      actorId: actingUserId,
      action: 'memory_confirmed',
      entityType: 'memory',
      entityId: memoryId,
      detail: { memory_type: existing.memory_type },
    });
    return rows[0];
  });
}

export async function rejectMemory(memoryId, actingUserId) {
  const existing = await loadMemoryForWrite(memoryId, actingUserId);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE memories SET status = 'rejected', updated_at = now() WHERE id = $1 RETURNING *`,
      [memoryId]
    );
    await recordAudit(client, {
      projectId: existing.project_id,
      actorId: actingUserId,
      action: 'memory_rejected',
      entityType: 'memory',
      entityId: memoryId,
      detail: { memory_type: existing.memory_type, previous_status: existing.status },
    });
    return rows[0];
  });
}

export async function editMemory(memoryId, actingUserId, content) {
  if (!content) throw new Error('editMemory requires content');
  const existing = await loadMemoryForWrite(memoryId, actingUserId);

  const memory = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE memories SET content = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [memoryId, content]
    );
    await recordAudit(client, {
      projectId: existing.project_id,
      actorId: actingUserId,
      action: 'memory_edited',
      entityType: 'memory',
      entityId: memoryId,
      detail: { previous_content: existing.content, new_content: content },
    });
    return rows[0];
  });

  // Best-effort re-embed so semantic search reflects the edited content
  // rather than a stale embedding of the old content — same degrade-quietly
  // pattern used everywhere else embeddings are generated (extraction,
  // postMessage, uploadFile). Kept outside the transaction: it's network
  // I/O, and a slow/failed embedding call must never hold a DB transaction
  // open or roll back the content edit that already committed.
  if (embeddingsAvailable() && (await hasEmbeddingColumn('memories'))) {
    try {
      const [vector] = await embed([content]);
      if (vector) {
        await query(`UPDATE memories SET embedding = $1::vector WHERE id = $2`, [
          `[${vector.join(',')}]`,
          memoryId,
        ]);
      }
    } catch (err) {
      console.warn(`Embedding request failed (${err.message}) — memory content updated without a fresh embedding.`);
    }
  }

  return memory;
}

export async function deleteMemory(memoryId, actingUserId) {
  const existing = await loadMemoryForWrite(memoryId, actingUserId);
  return withTransaction(async (client) => {
    const { rows } = await client.query(`UPDATE memories SET deleted_at = now() WHERE id = $1 RETURNING *`, [
      memoryId,
    ]);
    await recordAudit(client, {
      projectId: existing.project_id,
      actorId: actingUserId,
      action: 'memory_deleted',
      entityType: 'memory',
      entityId: memoryId,
      detail: { memory_type: existing.memory_type },
    });
    return rows[0];
  });
}

// Explicit and user-driven only — nothing in this codebase calls this
// automatically. The old memory is retained with status='superseded', never
// deleted, so history stays inspectable. Both memories must belong to the
// SAME project (previously unchecked — a caller with write access to two
// different projects could otherwise splice memory history across them).
export async function supersedeMemory(oldMemoryId, newMemoryId, actingUserId) {
  const oldMemory = await loadMemoryForWrite(oldMemoryId, actingUserId);
  const newMemory = await loadMemoryForWrite(newMemoryId, actingUserId);
  if (oldMemory.project_id !== newMemory.project_id) {
    throw new Error(
      `Cannot supersede across projects: ${oldMemoryId} is in project ${oldMemory.project_id}, ${newMemoryId} is in project ${newMemory.project_id}`
    );
  }

  // Four statements (deactivate old, activate new, copy evidence, audit)
  // must succeed or fail together — a partial run would leave a memory
  // marked superseded with no active replacement, or vice versa.
  return withTransaction(async (client) => {
    const { rows: oldRows } = await client.query(
      `UPDATE memories SET status = 'superseded', updated_at = now() WHERE id = $1 RETURNING *`,
      [oldMemoryId]
    );
    const { rows: newRows } = await client.query(
      `UPDATE memories SET status = 'active', supersedes_memory_id = $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [newMemoryId, oldMemoryId]
    );
    await client.query(
      `INSERT INTO memory_evidence (memory_id, source_type, conversation_id, message_id, file_id, file_chunk_id, quote, evidence_role)
       SELECT $1, source_type, conversation_id, message_id, file_id, file_chunk_id, quote, 'supersedes'
       FROM memory_evidence WHERE memory_id = $2`,
      [newMemoryId, oldMemoryId]
    );
    await recordAudit(client, {
      projectId: oldMemory.project_id,
      actorId: actingUserId,
      action: 'memory_superseded',
      entityType: 'memory',
      entityId: oldMemoryId,
      detail: { supersededBy: newMemoryId },
    });
    return { old: oldRows[0], new: newRows[0] };
  });
}

// Naive same-type + trigram-similarity conflict hint, surfaced to the caller
// (e.g. printed by `memory confirm`) — never auto-resolved. A real conflict
// resolver would be a second pass over this candidate list.
//
// This surfaces other memories' `content` directly to the caller, so it's
// subject to the same evidence-visibility rule as listMemories/
// getMemoryWithEvidence — otherwise a caller could learn a private-derived
// memory's content through the conflict hint even though they couldn't see
// it via `memory list`/`memory show`.
export async function findPotentialConflicts(projectId, memoryId, actingUserId) {
  await assertProjectRead(projectId, actingUserId);
  const { rows: mRows } = await query(`SELECT * FROM memories WHERE id = $1`, [memoryId]);
  if (mRows.length === 0) return [];
  const memory = mRows[0];
  const { rows } = await query(
    `SELECT id, content, status, created_at FROM memories
     WHERE project_id = $1 AND memory_type = $2 AND status = 'active' AND id <> $3 AND deleted_at IS NULL
       AND similarity(content, $4) > 0.25
     ORDER BY similarity(content, $4) DESC`,
    [projectId, memory.memory_type, memoryId, memory.content]
  );
  return (await attachVisibleEvidence(rows, actingUserId)).filter((m) => m.evidence.length > 0);
}
