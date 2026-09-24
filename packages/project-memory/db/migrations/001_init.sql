-- Core schema for the project-memory prototype.
-- gen_random_uuid() is built into Postgres 13+ core, no extension required.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- NOTE: user identity is a free-text id (e.g. "alice") for this prototype —
-- there is no users/auth table. A real system would replace `text` user
-- columns with a foreign key into a users table.

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  title text,
  visibility text NOT NULL DEFAULT 'project' CHECK (visibility IN ('private', 'project')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE conversation_acl (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  permission text NOT NULL CHECK (permission IN ('read', 'write')),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  author_id text,
  content text NOT NULL,
  sequence_number integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX messages_content_trgm_idx ON messages USING gin (content gin_trgm_ops);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, sequence_number);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  filename text NOT NULL,
  media_type text,
  sha256 text NOT NULL,
  object_key text NOT NULL,
  visibility text NOT NULL DEFAULT 'project' CHECK (visibility IN ('private', 'project')),
  processing_status text NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'ready', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (project_id, sha256)
);

CREATE TABLE file_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  sha256 text NOT NULL,
  object_key text NOT NULL,
  extraction_status text NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending', 'extracted', 'unsupported', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, version_number)
);

CREATE TABLE file_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_version_id uuid NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  text text NOT NULL,
  page_number integer,
  token_count integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_chunks_text_trgm_idx ON file_chunks USING gin (text gin_trgm_ops);
-- `embedding vector(1536)` is added by 002_vector.optional.sql once pgvector is installed.

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  owner_id text NOT NULL,
  scope text NOT NULL DEFAULT 'project' CHECK (scope IN ('project', 'conversation')),
  memory_type text NOT NULL CHECK (memory_type IN ('decision', 'requirement', 'preference', 'deadline', 'fact', 'open_question')),
  subject text,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'superseded', 'rejected', 'expired')),
  certainty text NOT NULL DEFAULT 'uncertain' CHECK (certainty IN ('confirmed', 'probable', 'uncertain', 'disputed')),
  origin text NOT NULL DEFAULT 'inferred_from_multiple_sources' CHECK (origin IN ('explicit_user_statement', 'explicit_project_decision', 'inferred_from_multiple_sources', 'imported_from_file', 'user_created')),
  confidence numeric,
  importance numeric,
  valid_from timestamptz,
  valid_until timestamptz,
  supersedes_memory_id uuid REFERENCES memories(id),
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX memories_content_trgm_idx ON memories USING gin (content gin_trgm_ops);
CREATE INDEX memories_project_status_idx ON memories (project_id, status);

-- One memory can have several supporting/contradicting/superseding sources —
-- this is the structured citation layer, not a bare source-id array.
CREATE TABLE memory_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('message', 'file_chunk')),
  conversation_id uuid REFERENCES conversations(id),
  message_id uuid REFERENCES messages(id),
  file_id uuid REFERENCES files(id),
  file_chunk_id uuid REFERENCES file_chunks(id),
  quote text NOT NULL,
  evidence_role text NOT NULL DEFAULT 'supports' CHECK (evidence_role IN ('supports', 'contradicts', 'supersedes')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_evidence_memory_idx ON memory_evidence (memory_id);
