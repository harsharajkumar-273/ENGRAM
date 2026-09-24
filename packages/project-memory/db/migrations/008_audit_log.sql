-- Administrative/curatorial audit trail: who granted access to a project, and
-- who confirmed/edited/rejected/deleted/superseded a memory, uploaded a
-- file, or ran extraction — and when. Deliberately NOT a log of message
-- posts: the messages table is already an append-only record of
-- conversation content (this project's core design principle, see README),
-- so logging every post here would just be a redundant copy of it. This
-- table is for the layer on top that changes what the system treats as
-- true, or who can see what.
--
-- Required (not optional like 002/007) — pure Postgres, no external
-- dependency, so there's no reason for this to ever be missing.
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('project', 'member', 'memory', 'file', 'conversation')),
  -- Nullable: some actions (e.g. adding a member) don't have a single uuid
  -- entity to point at — project_members' key is composite, not a uuid — so
  -- those put identifying detail in `detail` instead (see audit.js).
  entity_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_project_created_idx ON audit_log (project_id, created_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
