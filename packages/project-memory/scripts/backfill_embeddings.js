#!/usr/bin/env node
// Backfills embeddings for rows that predate an embeddings provider being
// configured, or predate a table's optional pgvector migration being
// applied — new rows get embedded at write time (see uploadFile in
// files.js, postMessage in conversations.js, extractCandidates/editMemory in
// memory/extract.js and memory/lifecycle.js), but nothing retroactively
// embeds rows written before that. Idempotent and safe to rerun: only rows
// with embedding IS NULL are selected each time.
import { query, hasEmbeddingColumn, closePool } from '../src/db.js';
import { embed, embeddingsAvailable } from '../src/embeddings.js';

const BATCH_SIZE = 100;

async function backfillTable({ table, idColumn, textColumn, where }) {
  if (!(await hasEmbeddingColumn(table))) {
    console.log(`${table}: no embedding column yet (run its optional migration first) — skipping.`);
    return;
  }

  const { rows } = await query(
    `SELECT ${idColumn} AS id, ${textColumn} AS text FROM ${table} WHERE embedding IS NULL ${where}`
  );
  if (rows.length === 0) {
    console.log(`${table}: nothing to backfill.`);
    return;
  }

  console.log(`${table}: backfilling ${rows.length} row(s)...`);
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    let vectors;
    try {
      vectors = await embed(batch.map((r) => r.text));
    } catch (err) {
      console.warn(`  batch starting at ${i} failed (${err.message}) — will remain NULL, rerun later.`);
      continue;
    }
    for (let j = 0; j < batch.length; j++) {
      if (!vectors[j]) continue;
      await query(`UPDATE ${table} SET embedding = $1::vector WHERE ${idColumn} = $2`, [
        `[${vectors[j].join(',')}]`,
        batch[j].id,
      ]);
      done++;
    }
    console.log(`  ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
  }
  console.log(`${table}: embedded ${done}/${rows.length} row(s) (rest failed and can be retried by rerunning).`);
}

async function main() {
  if (!embeddingsAvailable()) {
    console.error('OPENAI_API_KEY (or whichever provider embed() is configured for) is not set — nothing to do.');
    process.exitCode = 1;
    return;
  }

  await backfillTable({
    table: 'file_chunks',
    idColumn: 'id',
    textColumn: 'text',
    where: '',
  });
  await backfillTable({
    table: 'messages',
    idColumn: 'id',
    textColumn: 'content',
    where: 'AND deleted_at IS NULL',
  });
  await backfillTable({
    table: 'memories',
    idColumn: 'id',
    textColumn: 'content',
    where: "AND deleted_at IS NULL AND status IN ('proposed', 'active')",
  });
}

main()
  .catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
