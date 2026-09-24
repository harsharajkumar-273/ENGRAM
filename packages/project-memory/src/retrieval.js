import { query, hasEmbeddingColumn } from './db.js';
import { embed, embeddingsAvailable } from './embeddings.js';
import { attachVisibleEvidence } from './access.js';

const STOPWORDS = new Set([
  'what', 'which', 'when', 'where', 'how', 'does', 'do', 'the', 'a', 'an', 'is',
  'are', 'was', 'were', 'will', 'before', 'after', 'about', 'that', 'this',
  'with', 'from', 'into', 'over', 'under', 'remains', 'remain', 'still', 'have',
]);

function extractKeywords(text) {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    ),
  ];
}

// Merges a vector-search leg into an existing keyword/trigram leg's rows,
// keyed by `keyField`. Fixes a real duplication bug the earlier version had
// for file_chunks: naively concatenating the two legs let the same row
// appear twice in the final result list — once because it matched on
// keywords/trigram similarity, once because it also matched semantically.
// A row present in both legs keeps one entry: `match_count` carries over
// from the keyword leg (0 if it only matched via the vector leg), and
// `trgm_score` becomes the higher of the two legs' similarity scores, so a
// row doesn't need to re-win the sort on the keyword leg's terms alone.
function mergeVectorLeg(baseRows, vectorRows, keyField) {
  const byKey = new Map(baseRows.map((r) => [r[keyField], { ...r }]));
  for (const v of vectorRows) {
    const key = v[keyField];
    const existing = byKey.get(key);
    if (existing) {
      existing.trgm_score = Math.max(Number(existing.trgm_score ?? 0), Number(v.vector_score ?? 0));
    } else {
      byKey.set(key, { ...v, match_count: 0, trgm_score: v.vector_score });
    }
  }
  return [...byKey.values()];
}

// Project-level search across multiple knowledge layers (active memories,
// conversation messages, file chunks) — not "search memory only". Every query
// filters by project membership / conversation visibility / ACL in SQL, so
// unauthorized rows never leave the database — this is not a fetch-then-filter
// pattern.
export async function hybridSearch(
  projectId,
  userId,
  queryText,
  // embedFn/checkEmbeddingAvailable are injectable seams for testing the
  // vector leg deterministically without a real embeddings API key — tests
  // pass a fake embedder that returns a known vector and force this true;
  // every real caller gets the actual embed()/embeddingsAvailable() from
  // embeddings.js by leaving these at their defaults.
  { limit = 10, embedFn = embed, checkEmbeddingAvailable = embeddingsAvailable } = {}
) {
  const memberCheck = await query(
    `SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2`,
    [projectId, userId]
  );
  if (memberCheck.rows.length === 0) {
    return { memories: [], sources: [], denied: true };
  }

  const keywords = extractKeywords(queryText);

  let memoryRows = (
    await query(
      `SELECT id, memory_type, subject, content, status, certainty, confidence, importance,
              supersedes_memory_id,
              (SELECT count(*) FROM unnest($3::text[]) kw WHERE content ILIKE '%' || kw || '%') AS match_count,
              similarity(content, $2) AS trgm_score
       FROM memories
       WHERE project_id = $1 AND deleted_at IS NULL AND status = 'active'
         AND (
           (SELECT count(*) FROM unnest($3::text[]) kw WHERE content ILIKE '%' || kw || '%') > 0
           OR similarity(content, $2) > 0.2
         )
       ORDER BY match_count DESC, trgm_score DESC
       LIMIT $4`,
      [projectId, queryText, keywords, limit]
    )
  ).rows;

  let messageRows = (
    await query(
      `SELECT m.id AS message_id, m.conversation_id, c.title AS conversation_title, m.content,
              (SELECT count(*) FROM unnest($4::text[]) kw WHERE m.content ILIKE '%' || kw || '%') AS match_count,
              similarity(m.content, $2) AS trgm_score
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.project_id = $1
         AND m.deleted_at IS NULL
         AND (
           c.visibility = 'project'
           OR c.owner_id = $3
           OR EXISTS (SELECT 1 FROM conversation_acl a WHERE a.conversation_id = c.id AND a.user_id = $3)
         )
         AND (
           (SELECT count(*) FROM unnest($4::text[]) kw WHERE m.content ILIKE '%' || kw || '%') > 0
           OR similarity(m.content, $2) > 0.2
         )
       ORDER BY match_count DESC, trgm_score DESC
       LIMIT $5`,
      [projectId, queryText, userId, keywords, limit]
    )
  ).rows;

  let fileChunkRows = (
    await query(
      `SELECT fc.id AS chunk_id, fc.text, fc.page_number, f.filename, f.id AS file_id,
              (SELECT count(*) FROM unnest($4::text[]) kw WHERE fc.text ILIKE '%' || kw || '%') AS match_count,
              similarity(fc.text, $2) AS trgm_score
       FROM file_chunks fc
       JOIN file_versions fv ON fv.id = fc.file_version_id
       JOIN files f ON f.id = fv.file_id
       WHERE f.project_id = $1
         AND f.deleted_at IS NULL
         AND (f.visibility = 'project' OR f.owner_id = $3)
         AND (
           (SELECT count(*) FROM unnest($4::text[]) kw WHERE fc.text ILIKE '%' || kw || '%') > 0
           OR similarity(fc.text, $2) > 0.2
         )
       ORDER BY match_count DESC, trgm_score DESC
       LIMIT $5`,
      [projectId, queryText, userId, keywords, limit]
    )
  ).rows;

  // Vector legs — merged in alongside keyword results once pgvector + an
  // embeddings provider key are both available for a given table (checked
  // per-table: file_chunks via 002_vector.optional.sql, messages/memories via
  // 007_message_memory_embeddings.optional.sql — see db.js's
  // hasEmbeddingColumn). This is the semantic-search layer: it's what lets a
  // query match a memory or message that doesn't share literal
  // words/trigrams with it. See scripts/backfill_embeddings.js to populate
  // embeddings for rows written before a table's migration was applied.
  if (checkEmbeddingAvailable()) {
    const [qVector] = await embedFn([queryText]);
    if (qVector) {
      const vectorLiteral = `[${qVector.join(',')}]`;

      if (await hasEmbeddingColumn('memories')) {
        const { rows: vectorMemoryRows } = await query(
          `SELECT id, memory_type, subject, content, status, certainty, confidence, importance,
                  supersedes_memory_id,
                  1 - (embedding <=> $2::vector) AS vector_score
           FROM memories
           WHERE project_id = $1 AND deleted_at IS NULL AND status = 'active' AND embedding IS NOT NULL
             AND 1 - (embedding <=> $2::vector) > 0.3
           ORDER BY embedding <=> $2::vector
           LIMIT $3`,
          [projectId, vectorLiteral, limit]
        );
        memoryRows = mergeVectorLeg(memoryRows, vectorMemoryRows, 'id');
      }

      if (await hasEmbeddingColumn('messages')) {
        const { rows: vectorMessageRows } = await query(
          `SELECT m.id AS message_id, m.conversation_id, c.title AS conversation_title, m.content,
                  1 - (m.embedding <=> $2::vector) AS vector_score
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE c.project_id = $1
             AND m.deleted_at IS NULL
             AND m.embedding IS NOT NULL
             AND 1 - (m.embedding <=> $2::vector) > 0.3
             AND (
               c.visibility = 'project'
               OR c.owner_id = $4
               OR EXISTS (SELECT 1 FROM conversation_acl a WHERE a.conversation_id = c.id AND a.user_id = $4)
             )
           ORDER BY m.embedding <=> $2::vector
           LIMIT $3`,
          [projectId, vectorLiteral, limit, userId]
        );
        messageRows = mergeVectorLeg(messageRows, vectorMessageRows, 'message_id');
      }

      if (await hasEmbeddingColumn('file_chunks')) {
        const { rows: vectorChunkRows } = await query(
          `SELECT fc.id AS chunk_id, fc.text, fc.page_number, f.filename, f.id AS file_id,
                  1 - (fc.embedding <=> $2::vector) AS vector_score
           FROM file_chunks fc
           JOIN file_versions fv ON fv.id = fc.file_version_id
           JOIN files f ON f.id = fv.file_id
           WHERE f.project_id = $1
             AND f.deleted_at IS NULL
             AND (f.visibility = 'project' OR f.owner_id = $4)
             AND fc.embedding IS NOT NULL
             AND 1 - (fc.embedding <=> $2::vector) > 0.3
           ORDER BY fc.embedding <=> $2::vector
           LIMIT $3`,
          [projectId, vectorLiteral, limit, userId]
        );
        fileChunkRows = mergeVectorLeg(fileChunkRows, vectorChunkRows, 'chunk_id');
      }
    }
  }

  const sources = [
    ...messageRows.map((r) => ({ kind: 'message', ...r })),
    ...fileChunkRows.map((r) => ({ kind: 'file_chunk', ...r })),
  ]
    .sort((a, b) => b.match_count - a.match_count || b.trgm_score - a.trgm_score)
    .slice(0, limit);

  // messages/file_chunks above already filter by conversation/file visibility
  // in SQL. Memories don't carry their own visibility column — a memory's
  // evidence might cite a private conversation this user can't read — so the
  // same evidence-visibility filter used by buildContext applies here too,
  // dropping any memory match with zero evidence visible to this user.
  const visibleMemories = (await attachVisibleEvidence(memoryRows, userId)).filter(
    (m) => m.evidence.length > 0
  );

  return { memories: visibleMemories, sources, denied: false };
}
