-- memory_evidence's direct pointers to conversations/messages/files/file_chunks
-- (used so a memory's provenance can be traced even after the memory itself
-- outlives a single message) were missing ON DELETE CASCADE. That blocked
-- deleting a whole project: deleting its conversations/files hit a dangling
-- memory_evidence row with NO ACTION and aborted the delete. This matters for
-- real project deletion (e.g. GDPR-style removal), not just test cleanup —
-- deletion must cascade to every derived artifact, not just the top-level row.
ALTER TABLE memory_evidence DROP CONSTRAINT memory_evidence_conversation_id_fkey;
ALTER TABLE memory_evidence
  ADD CONSTRAINT memory_evidence_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;

ALTER TABLE memory_evidence DROP CONSTRAINT memory_evidence_message_id_fkey;
ALTER TABLE memory_evidence
  ADD CONSTRAINT memory_evidence_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;

ALTER TABLE memory_evidence DROP CONSTRAINT memory_evidence_file_id_fkey;
ALTER TABLE memory_evidence
  ADD CONSTRAINT memory_evidence_file_id_fkey
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE;

ALTER TABLE memory_evidence DROP CONSTRAINT memory_evidence_file_chunk_id_fkey;
ALTER TABLE memory_evidence
  ADD CONSTRAINT memory_evidence_file_chunk_id_fkey
  FOREIGN KEY (file_chunk_id) REFERENCES file_chunks(id) ON DELETE CASCADE;
