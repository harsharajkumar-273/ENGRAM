-- Extends the pgvector setup from 002_vector.optional.sql (which only
-- covered file_chunks) to messages and memories, so semantic search isn't
-- limited to uploaded files — a query can match a decision or a message that
-- shares no literal words/trigrams with it. Same optional-migration
-- convention as 002: this fails harmlessly (and is retried automatically by
-- migrate.js on the next run) until pgvector is installed via 002.
--
-- After this applies, existing rows still have embedding = NULL until
-- they're backfilled — see scripts/backfill_embeddings.js. New rows are
-- embedded best-effort at write time (postMessage in conversations.js,
-- extractCandidates/editMemory in memory/extract.js and memory/lifecycle.js).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS messages_embedding_idx
  ON messages USING hnsw (embedding vector_cosine_ops);

ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS memories_embedding_idx
  ON memories USING hnsw (embedding vector_cosine_ops);
