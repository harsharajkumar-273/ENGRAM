import { readFile, copyFile, mkdir, access } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, withTransaction, hasEmbeddingColumn } from './db.js';
import { sha256 } from './hashing.js';
import { extractText, chunkText } from './textExtract.js';
import { embed, embeddingsAvailable } from './embeddings.js';
import { assertProjectWrite, isMember } from './projects.js';
import { recordAudit } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storageRoot = path.join(__dirname, '..', 'storage');

export async function canReadFile(fileId, userId) {
  const { rows } = await query(
    `SELECT project_id, owner_id, visibility FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [fileId]
  );
  if (rows.length === 0) return false;
  const f = rows[0];
  if (f.visibility === 'project') return isMember(f.project_id, userId);
  return f.owner_id === userId;
}

// Ingestion pipeline: hash -> dedup -> store (local filesystem stands in for
// S3) -> extract text -> chunk -> embed (best-effort). Runs synchronously for
// this prototype; a real deployment would push extraction/chunking/embedding
// onto the Redis/BullMQ queue already running locally (deferred, see plan).
export async function uploadFile(projectId, ownerId, filePath, { visibility = 'project' } = {}) {
  // Uploading is a write action — viewers are read-only.
  await assertProjectWrite(projectId, ownerId);

  const buf = await readFile(filePath);
  const hash = sha256(buf);
  const filename = path.basename(filePath);
  const { text, unsupported } = await extractText(filePath);
  const chunks = text ? chunkText(text) : [];

  // The dedup-check-through-chunk-inserts sequence must be all-or-nothing: a
  // crash partway through previously could leave a `files` row with no
  // `file_versions`/`file_chunks`, or vice versa. Embedding calls (network
  // I/O) intentionally stay OUTSIDE this transaction — holding a DB
  // transaction open across a slow external call is bad practice, and
  // embeddings are already best-effort (see below).
  const { file, fileVersion, chunkIds, isNewFile } = await withTransaction(async (client) => {
    // Dedup domain matters for privacy: reusing a `files` row across
    // different owners/visibility would silently attach a new uploader to
    // someone else's (possibly private) file record, inheriting its
    // owner_id and visibility. Byte-level storage is still deduplicated
    // below (object_key is content-addressed by hash) — only the LOGICAL
    // record is now scoped: project-visible files dedup across the whole
    // project (anyone there can see it either way); private files dedup
    // only within the same uploader's own prior private uploads (migration
    // 006 enforces this at the DB level via partial unique indexes).
    const existing =
      visibility === 'project'
        ? await client.query(
            `SELECT * FROM files WHERE project_id = $1 AND sha256 = $2 AND visibility = 'project'`,
            [projectId, hash]
          )
        : await client.query(
            `SELECT * FROM files WHERE project_id = $1 AND sha256 = $2 AND visibility = 'private' AND owner_id = $3`,
            [projectId, hash, ownerId]
          );

    let file;
    let isNewFile = false;
    if (existing.rows.length > 0) {
      file = existing.rows[0];
    } else {
      isNewFile = true;
      const objectKey = path.join('storage', hash);
      const { rows } = await client.query(
        `INSERT INTO files (project_id, owner_id, filename, sha256, object_key, visibility, processing_status)
         VALUES ($1, $2, $3, $4, $5, $6, 'processing') RETURNING *`,
        [projectId, ownerId, filename, hash, objectKey, visibility]
      );
      file = rows[0];
    }

    const { rows: versionRows } = await client.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM file_versions WHERE file_id = $1`,
      [file.id]
    );
    const versionNumber = versionRows[0].next;

    const { rows: fvRows } = await client.query(
      `INSERT INTO file_versions (file_id, version_number, sha256, object_key, extraction_status)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [file.id, versionNumber, hash, file.object_key, unsupported ? 'unsupported' : text ? 'extracted' : 'failed']
    );
    const fileVersion = fvRows[0];

    const chunkIds = [];
    for (let i = 0; i < chunks.length; i++) {
      const { rows } = await client.query(
        `INSERT INTO file_chunks (file_version_id, chunk_index, text) VALUES ($1, $2, $3) RETURNING id`,
        [fileVersion.id, i, chunks[i]]
      );
      chunkIds.push(rows[0].id);
    }

    await recordAudit(client, {
      projectId,
      actorId: ownerId,
      action: isNewFile ? 'file_uploaded' : 'file_upload_deduped',
      entityType: 'file',
      entityId: file.id,
      detail: { filename, visibility, version_number: versionNumber, chunk_count: chunkIds.length },
    });

    return { file, fileVersion, chunkIds, isNewFile };
  });

  // Copy bytes to local storage only after the DB transaction has committed a
  // new file row — if the transaction rolled back, we haven't wasted a
  // filesystem write. (The reverse gap — a successful commit followed by a
  // failed fs copy — is a known, documented limitation of pairing a DB
  // transaction with non-transactional storage; a real deployment pairing
  // Postgres with S3 has the same edge case.)
  if (isNewFile) {
    const objectPath = path.join(__dirname, '..', file.object_key);
    // The object_key is content-addressed by hash alone, so two different
    // owners' private uploads of identical bytes share the same on-disk
    // path even though they now get separate `files` rows (see the dedup
    // query above) — skip the copy if another owner's upload already wrote
    // these exact bytes.
    const alreadyOnDisk = await access(objectPath)
      .then(() => true)
      .catch(() => false);
    if (!alreadyOnDisk) {
      await mkdir(storageRoot, { recursive: true });
      await copyFile(filePath, objectPath);
    }
  }

  if (chunkIds.length > 0 && embeddingsAvailable() && (await hasEmbeddingColumn())) {
    let vectors;
    try {
      vectors = await embed(chunks);
    } catch (err) {
      console.warn(`Embedding request failed (${err.message}) — chunks stored without embeddings.`);
      vectors = chunks.map(() => null);
    }
    for (let i = 0; i < chunkIds.length; i++) {
      if (vectors[i]) {
        await query(`UPDATE file_chunks SET embedding = $1::vector WHERE id = $2`, [
          `[${vectors[i].join(',')}]`,
          chunkIds[i],
        ]);
      }
    }
  }

  await query(`UPDATE files SET processing_status = 'ready' WHERE id = $1`, [file.id]);

  return { file, fileVersion, chunkCount: chunkIds.length, unsupported };
}
