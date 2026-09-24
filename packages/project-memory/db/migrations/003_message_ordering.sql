-- postMessage assigns sequence_number via an atomic INSERT...SELECT
-- (COALESCE(MAX(sequence_number),0)+1) rather than a separate SELECT-then-
-- INSERT, closing a read-then-write race between concurrent posts to the
-- same conversation. This constraint turns any remaining race into a loud,
-- retryable unique_violation (23505) instead of silently duplicating or
-- corrupting message order — postMessage() retries on exactly this error.
ALTER TABLE messages
  ADD CONSTRAINT messages_conversation_sequence_unique UNIQUE (conversation_id, sequence_number);
