import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres:///project_memory_proto',
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Whether a table has an `embedding` column applied yet — true once its
// optional pgvector migration has run (002_vector.optional.sql for
// file_chunks, 007_message_memory_embeddings.optional.sql for messages and
// memories). Cached per table after first check. Every place that would
// touch embeddings checks this instead of assuming pgvector is present, so
// the app runs correctly before and after those migrations, and correctly
// per-table if only some of them have been applied.
const embeddingColumnCache = new Map();
export async function hasEmbeddingColumn(table = 'file_chunks') {
  if (embeddingColumnCache.has(table)) return embeddingColumnCache.get(table);
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'embedding'`,
    [table]
  );
  const result = rows.length > 0;
  embeddingColumnCache.set(table, result);
  return result;
}

// Every entry point (cli.js, migrate.js's counterpart in seed_demo.js, ...)
// must call this before exiting. Without it, Node keeps the process alive
// until pg's idle-connection timeout (10s by default) elapses even after all
// work is done — a real, measured bug: `memory list` took 10.7s wall time
// with nothing but this open pool keeping the event loop alive.
export async function closePool() {
  await pool.end();
}

export default pool;
