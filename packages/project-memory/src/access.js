import { query } from './db.js';
// Attaches only the memory_evidence rows `userId` is actually authorized to
// see to each memory — a memory's content may be project-scoped, but if it
// was extracted from a private conversation the caller can't read, the
// quote/source pointer must not leak to them.
//
// This does NOT drop memories with zero visible evidence itself — every
// current caller (listMemories, getMemoryWithEvidence, findPotentialConflicts,
// buildContext, hybridSearch) immediately filters on `.evidence.length > 0`
// to decide whether the memory is visible at all. The filtering lives at the
// call site rather than here only so a memory with genuinely zero evidence
// rows (not a privacy exclusion, just no evidence yet) could in principle be
// handled differently in the future — no current code path creates such a
// memory, since extraction always inserts a memory and its evidence
// together (see memory/extract.js).
export async function attachVisibleEvidence(memories, userId) {
  if (memories.length === 0) return [];

  // Resolve evidence and its source visibility in one set-based query. The
  // earlier implementation queried once per memory and then once again per
  // evidence row, which became increasingly expensive as a project grew.
  const memoryIds = memories.map((m) => m.id);
  const { rows } = await query(
    `SELECT me.*
     FROM memory_evidence me
     LEFT JOIN conversations c
       ON me.source_type = 'message' AND c.id = me.conversation_id
     LEFT JOIN files f
       ON me.source_type = 'file_chunk' AND f.id = me.file_id AND f.deleted_at IS NULL
     WHERE me.memory_id = ANY($1::uuid[])
       AND (
         (
           me.source_type = 'message'
           AND c.id IS NOT NULL
           AND (
             c.owner_id = $2
             OR EXISTS (
               SELECT 1 FROM conversation_acl a
               WHERE a.conversation_id = c.id AND a.user_id = $2
             )
             OR (
               c.visibility = 'project'
               AND EXISTS (
                 SELECT 1 FROM project_members pm
                 WHERE pm.project_id = c.project_id AND pm.user_id = $2
               )
             )
           )
         )
         OR
         (
           me.source_type = 'file_chunk'
           AND f.id IS NOT NULL
           AND (
             f.owner_id = $2
             OR (
               f.visibility = 'project'
               AND EXISTS (
                 SELECT 1 FROM project_members pm
                 WHERE pm.project_id = f.project_id AND pm.user_id = $2
               )
             )
           )
         )
       )
     ORDER BY me.created_at, me.id`,
    [memoryIds, userId]
  );

  const evidenceByMemory = new Map(memoryIds.map((id) => [id, []]));
  for (const evidence of rows) evidenceByMemory.get(evidence.memory_id)?.push(evidence);
  return memories.map((memory) => ({ ...memory, evidence: evidenceByMemory.get(memory.id) ?? [] }));
}

// Throws (as "not found", not "access denied" — indistinguishable from a
// nonexistent memory so existence isn't leaked either) unless `userId` can
// see at least one piece of the memory's evidence, OR the memory has no
// evidence rows at all (nothing to hide, so nothing to gate on — see the
// note above). Every WRITE path for an existing memory (confirm/reject/
// edit/delete/supersede) must call this in addition to a project-role write
// check: an editor with general project write access must not be able to
// confirm/edit/delete/supersede a memory whose evidence they can't even see,
// just because they have write access to the project and happen to know (or
// guess) its id.
export async function assertMemoryVisible(memory, userId) {
  const { rows: anyEvidence } = await query(`SELECT 1 FROM memory_evidence WHERE memory_id = $1 LIMIT 1`, [
    memory.id,
  ]);
  if (anyEvidence.length === 0) return;
  const [withEvidence] = await attachVisibleEvidence([memory], userId);
  if (withEvidence.evidence.length === 0) {
    throw new Error(`Memory ${memory.id} not found`);
  }
}
