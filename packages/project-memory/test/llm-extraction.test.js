import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateLLMCandidate, quoteIsVerbatimOrNearVerbatim } from '../src/memory/extract.js';
import { closePool } from '../src/db.js';

// These exercise the trust boundary between an LLM's claimed JSON and what
// actually gets inserted — validateLLMCandidate() is the one thing standing
// between a hallucinated citation and a memory row. No network/API key is
// needed here: we hand it fabricated "model output" objects directly.

function fakeMessage(content) {
  return { id: randomUUID(), content };
}

test('an exact verbatim quote is accepted', async () => {
  const msg = fakeMessage('We will use OAuth for third-party authentication.');
  const messageById = new Map([[msg.id, msg]]);
  const result = await validateLLMCandidate(
    { message_id: msg.id, quote: 'We will use OAuth for third-party authentication.', memory_type: 'decision', certainty: 'confirmed' },
    messageById
  );
  assert.ok(result, 'expected the candidate to be accepted');
  assert.equal(result.content, 'We will use OAuth for third-party authentication.');
  assert.equal(result.createdBy, 'llm_extractor');
});

test('an invented certainty value like "speculative" is rejected, not just downgraded', async () => {
  const msg = fakeMessage('We will use OAuth for third-party authentication.');
  const messageById = new Map([[msg.id, msg]]);
  const result = await validateLLMCandidate(
    { message_id: msg.id, quote: 'We will use OAuth for third-party authentication.', memory_type: 'decision', certainty: 'speculative' },
    messageById
  );
  assert.equal(result, null, 'a certainty value outside the fixed enum must never be inserted');
});

test('an invented memory_type is rejected', async () => {
  const msg = fakeMessage('We will use OAuth for third-party authentication.');
  const messageById = new Map([[msg.id, msg]]);
  const result = await validateLLMCandidate(
    { message_id: msg.id, quote: 'We will use OAuth for third-party authentication.', memory_type: 'insight', certainty: 'confirmed' },
    messageById
  );
  assert.equal(result, null);
});

test('a quote cited against the wrong message is rejected even if it is verbatim from a DIFFERENT message', async () => {
  const realSource = fakeMessage('We will use OAuth for third-party authentication.');
  const wrongSource = fakeMessage('The database migration is scheduled for next week.');
  const messageById = new Map([[realSource.id, realSource], [wrongSource.id, wrongSource]]);
  const result = await validateLLMCandidate(
    // quote is verbatim, but message_id points at wrongSource, which never said this
    { message_id: wrongSource.id, quote: 'We will use OAuth for third-party authentication.', memory_type: 'decision', certainty: 'confirmed' },
    messageById
  );
  assert.equal(result, null, 'a verbatim-but-mis-cited quote is still a fabricated citation');
});

test('a fabricated quote with no real match in the source message is rejected', async () => {
  const msg = fakeMessage('We discussed a few auth options but have not settled on one yet.');
  const messageById = new Map([[msg.id, msg]]);
  const result = await validateLLMCandidate(
    { message_id: msg.id, quote: 'We will use OAuth for third-party authentication.', memory_type: 'decision', certainty: 'confirmed' },
    messageById
  );
  assert.equal(result, null);
});

test('an unknown message_id is rejected', async () => {
  const messageById = new Map();
  const result = await validateLLMCandidate(
    { message_id: randomUUID(), quote: 'anything', memory_type: 'fact', certainty: 'confirmed' },
    messageById
  );
  assert.equal(result, null);
});

test('quoteIsVerbatimOrNearVerbatim tolerates smart quotes and extra whitespace, not paraphrase', async () => {
  const content = 'The team decided to ship on March 3rd.';
  assert.equal(await quoteIsVerbatimOrNearVerbatim('The   team decided to ship on March 3rd.', content), true);
  assert.equal(
    await quoteIsVerbatimOrNearVerbatim('The team has fully committed to shipping in early March.', content),
    false,
    'a paraphrase is not the same as trivial transcription noise'
  );
});

after(async () => {
  await closePool();
});
