import { query, withTransaction, hasEmbeddingColumn } from './db.js';
import { assertProjectRead, assertProjectWrite } from './projects.js';
import { embed, embeddingsAvailable } from './embeddings.js';

export async function createConversation(projectId, ownerId, { title, visibility = 'project' } = {}) {
  // Creating a conversation is a write action — viewers are read-only.
  await assertProjectWrite(projectId, ownerId);
  const { rows } = await query(
    `INSERT INTO conversations (project_id, owner_id, title, visibility)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [projectId, ownerId, title ?? null, visibility]
  );
  return rows[0];
}

export async function getConversation(conversationId) {
  const { rows } = await query(`SELECT * FROM conversations WHERE id = $1`, [conversationId]);
  return rows[0] ?? null;
}

// Read-level: any project member (project-visibility), or the conversation
// owner, or ANY conversation_acl row regardless of its permission value — a
// 'read' ACL grant is still enough to read.
export async function assertConversationRead(conversationId, userId) {
  const convo = await getConversation(conversationId);
  if (!convo) throw new Error(`Conversation ${conversationId} not found`);

  if (convo.visibility === 'project') {
    await assertProjectRead(convo.project_id, userId);
    return convo;
  }

  if (convo.owner_id === userId) return convo;

  const { rows } = await query(
    `SELECT 1 FROM conversation_acl WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  if (rows.length > 0) return convo;

  throw new Error(`Access denied: user "${userId}" cannot read conversation ${conversationId}`);
}

// Write-level: any project WRITE-role member (project-visibility), or the
// conversation owner, or a conversation_acl row whose permission is
// specifically 'write'. A read-only ACL grant must NOT be enough to post —
// that was the bug: assertConversationAccess previously treated any ACL row
// as license to write.
export async function assertConversationWrite(conversationId, userId) {
  const convo = await getConversation(conversationId);
  if (!convo) throw new Error(`Conversation ${conversationId} not found`);

  if (convo.visibility === 'project') {
    await assertProjectWrite(convo.project_id, userId);
    return convo;
  }

  if (convo.owner_id === userId) return convo;

  const { rows } = await query(
    `SELECT 1 FROM conversation_acl WHERE conversation_id = $1 AND user_id = $2 AND permission = 'write'`,
    [conversationId, userId]
  );
  if (rows.length > 0) return convo;

  throw new Error(`Access denied: user "${userId}" cannot write to conversation ${conversationId}`);
}

// Read-only, for the UI's conversation list: project-visibility conversations
// (requires being a project member at all) plus any private conversations
// this user owns or is ACL'd into — the same rule assertConversationRead
// encodes per-row, expressed as a set query instead.
export async function listConversationsForUser(projectId, actingUserId) {
  await assertProjectRead(projectId, actingUserId);
  const { rows } = await query(
    `SELECT * FROM conversations
     WHERE project_id = $1
       AND (
         visibility = 'project'
         OR owner_id = $2
         OR EXISTS (SELECT 1 FROM conversation_acl a WHERE a.conversation_id = conversations.id AND a.user_id = $2)
       )
     ORDER BY created_at DESC`,
    [projectId, actingUserId]
  );
  return rows;
}

export async function canReadConversation(conversationId, userId) {
  try {
    await assertConversationRead(conversationId, userId);
    return true;
  } catch {
    return false;
  }
}

export async function postMessage(conversationId, authorId, { role = 'user', content }) {
  if (!content) throw new Error('postMessage requires content');
  await assertConversationWrite(conversationId, authorId);

  // Sequence numbers must be assigned atomically. An earlier version folded
  // the MAX computation into the INSERT's SELECT and retried on a
  // UNIQUE(conversation_id, sequence_number) conflict — but under real
  // concurrency that's a thundering herd: colliding writers retry and can
  // collide again immediately, with no backoff, and a fixed retry budget is
  // not guaranteed to be enough (empirically ~1-in-5 runs failed at just 20
  // concurrent writers). The correct fix is pessimistic, not optimistic:
  // SELECT ... FOR UPDATE on the conversation row inside a transaction
  // serializes concurrent posts to the SAME conversation — each waits for
  // the lock rather than racing — while different conversations are
  // untouched and still proceed fully in parallel. The UNIQUE constraint
  // (migration 003) remains as a defense-in-depth invariant; it should never
  // actually fire once this lock is in place.
  const message = await withTransaction(async (client) => {
    await client.query(`SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, [conversationId]);
    const { rows } = await client.query(
      `INSERT INTO messages (conversation_id, role, author_id, content, sequence_number)
       SELECT $1, $2, $3, $4, COALESCE(MAX(sequence_number), 0) + 1
       FROM messages WHERE conversation_id = $1
       RETURNING *`,
      [conversationId, role, authorId, content]
    );
    return rows[0];
  });

  // Embedding is best-effort, network I/O kept OUTSIDE the transaction above
  // (same reasoning as uploadFile in files.js) — a message is fully posted
  // and readable whether or not this succeeds. Only runs once the optional
  // 007_message_memory_embeddings.optional.sql migration has added the
  // column; see retrieval.js's semantic-search leg and
  // scripts/backfill_embeddings.js for messages posted before that.
  if (embeddingsAvailable() && (await hasEmbeddingColumn('messages'))) {
    try {
      const [vector] = await embed([content]);
      if (vector) {
        await query(`UPDATE messages SET embedding = $1::vector WHERE id = $2`, [
          `[${vector.join(',')}]`,
          message.id,
        ]);
      }
    } catch (err) {
      console.warn(`Embedding request failed (${err.message}) — message stored without an embedding.`);
    }
  }

  return message;
}

export async function listMessages(conversationId, actingUserId) {
  // Previously had NO access check at all — any caller (including
  // extractCandidates) could read messages from any conversation, private or
  // not, without being a member or having an ACL grant.
  await assertConversationRead(conversationId, actingUserId);
  const { rows } = await query(
    `SELECT * FROM messages WHERE conversation_id = $1 AND deleted_at IS NULL ORDER BY sequence_number`,
    [conversationId]
  );
  return rows;
}
