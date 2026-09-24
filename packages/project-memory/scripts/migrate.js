#!/usr/bin/env node
// Applies db/migrations/*.sql in filename order, tracked in a schema_migrations
// table it bootstraps itself.
//
// A failing migration rolls back cleanly and does NOT block later,
// independent migrations from being attempted — it used to `break` on the
// first failure, which meant a permanently-external-blocked migration would
// permanently prevent later ones from ever running.
//
// Filenames containing `.optional.` (e.g. 002_vector.optional.sql, which
// needs `brew install pgvector` first) are allowed to fail without affecting
// the exit code — they're expected to fail until an external prerequisite
// is satisfied, and that must never mask a REQUIRED migration failing for a
// real reason. Any non-optional migration failing sets a non-zero exit code,
// so `npm test` (which runs this first) correctly refuses to report success
// against a database that didn't get the schema it needs — only an optional
// migration's failure is swallowed, and only after being logged loudly.
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');

async function main() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || 'postgres:///project_memory_proto',
  });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const appliedRows = await client.query('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedRows.rows.map((r) => r.filename));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip (already applied): ${file}`);
      continue;
    }
    const isOptional = file.includes('.optional.');
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      if (isOptional) {
        console.warn(`SKIPPED (optional): ${file} — ${err.message}`);
        console.warn('This migration is optional; it does not affect the exit code. Rerun this script after satisfying its prerequisite.');
      } else {
        console.error(`FAILED: ${file} — ${err.message}`);
        console.error('Continuing to remaining migrations; rerun this script to retry the failed one.');
        process.exitCode = 1;
      }
      // Deliberately no `break` in either branch — see the file header. A
      // single stuck migration must not block unrelated ones behind it.
    }
  }

  await client.end();
}

main();
