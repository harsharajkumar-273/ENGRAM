-- Idempotency backstop for extraction: the same source message quoted with
-- the exact same text must never back two different EXTRACTED ('supports')
-- proposals. extractCandidates() serializes concurrent extraction per
-- conversation with a row lock (the same pattern conversations.js uses for
-- message sequence numbers), so this constraint should never actually fire
-- in normal operation — it exists as a hard guarantee in case that lock is
-- ever bypassed by a bug or a different code path.
--
-- Scoped to evidence_role = 'supports' specifically: supersedeMemory()
-- legitimately copies an old memory's evidence forward onto the new memory
-- as evidence_role = 'supersedes', which can and should reuse the exact same
-- (message_id, quote) pair as the original 'supports' row it's tracing
-- provenance from — that is not the race this constraint guards against.
CREATE UNIQUE INDEX memory_evidence_message_quote_supports_unique
  ON memory_evidence (message_id, quote)
  WHERE evidence_role = 'supports';
