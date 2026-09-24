-- The original UNIQUE(project_id, sha256) let uploadFile() reuse ANY file
-- with matching bytes in the project, regardless of who uploaded it or its
-- visibility. That meant Bob uploading bytes identical to Alice's PRIVATE
-- upload would silently attach to Alice's file record — inheriting her
-- owner_id and (private) visibility, rather than getting his own record.
--
-- Byte-level storage is still deduplicated (object_key is content-addressed
-- by sha256 in files.js, unchanged) — only the *logical* files row, which
-- carries ownership/visibility/metadata, is now scoped correctly:
--   - project-visible files: one row per (project, hash) regardless of
--     uploader, since anyone in the project can already see it either way.
--   - private files: one row per (project, hash, owner) — dedup only within
--     the SAME uploader's own private uploads, never across owners.
ALTER TABLE files DROP CONSTRAINT files_project_id_sha256_key;

CREATE UNIQUE INDEX files_project_hash_unique
  ON files (project_id, sha256)
  WHERE visibility = 'project';

CREATE UNIQUE INDEX files_private_owner_hash_unique
  ON files (project_id, sha256, owner_id)
  WHERE visibility = 'private';
