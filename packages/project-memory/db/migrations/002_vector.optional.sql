-- Deferred until pgvector is installed locally (see README "Adding real vector
-- search"). migrate.js applies migrations in order and stops cleanly if this
-- one fails, so it can simply be rerun later once `brew install pgvector` has
-- been done — earlier migrations stay applied.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE file_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536);

CREATE INDEX IF NOT EXISTS file_chunks_embedding_idx
  ON file_chunks USING hnsw (embedding vector_cosine_ops);
