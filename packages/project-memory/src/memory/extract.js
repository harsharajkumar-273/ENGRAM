import { query, withTransaction, hasEmbeddingColumn } from '../db.js';
import { listMessages } from '../conversations.js';
import { assertProjectWrite } from '../projects.js';
import { complete, llmAvailable } from '../llm.js';
import { embed, embeddingsAvailable } from '../embeddings.js';
import { recordAudit } from '../audit.js';

// --- Rule-based extraction (fallback when ANTHROPIC_API_KEY isn't set) -----
//
// This used to be the only extractor. It's now the deterministic fallback
// path — used automatically when no API key is configured, and automatically
// when a configured key fails at call time (see extractCandidates below,
// which mirrors the same "degrade to something useful, never crash" pattern
// `ask` already uses in cli.js for answer generation). Keeping it means the
// CLI and test suite both keep working with zero network access and zero
// API key, and it stays a useful sanity baseline to diff real LLM output
// against.

const MONTHS = '(January|February|March|April|May|June|July|August|September|October|November|December)';
const DATE_PATTERN = new RegExp(`\\b${MONTHS}\\s+\\d{1,2}\\b`, 'i');
const DEADLINE_KEYWORDS = /\b(launch|deadline|due date|target date|release date|ship date)\b/i;

// Checked BEFORE decision/requirement patterns — "leaning toward X" or "no
// final decision yet" must never be classified as a decision, even though it
// may also contain decision-shaped words like "will".
const UNCERTAIN_PATTERNS = [
  /\bleaning (toward|towards)\b/i,
  /\bno final decision\b/i,
  /\brevisit\b/i,
  /\bnot (finalized|decided|final)\b/i,
  /\bmight\b/i,
  /\bconsidering\b/i,
  /\bseems (better|good|preferable)\b/i,
  /\bstill deciding\b/i,
];

const DECISION_PATTERNS = [
  /\bwe (will use|decided|are going to|use)\b/i,
  /\bdecision:\s*/i,
  /\bthe (mvp|project|team|product) will\b/i,
  /\bwe(?:'|’)ve decided\b/i,
  /\bfinal(ized)? decision\b/i,
];

const REQUIREMENT_PATTERNS = [/\bmust\b/i, /\brequire[sd]?\b/i, /\balways\b/i, /\bnever\b/i, /\bdo not\b/i, /\bcannot\b/i];

const PREFERENCE_PATTERNS = [/\bprefer[s]?\b/i];

// Split on sentence-ending punctuation followed by whitespace, but NOT when
// that punctuation is part of a common abbreviation (e.g. "PostgreSQL vs.
// DynamoDB" must not be treated as two sentences — a naive split on "." would
// silently truncate the actual claim mid-sentence).
const ABBREVIATIONS = 'vs|Mr|Mrs|Dr|Ms|Inc|Ltd|etc|e\\.g|i\\.e|U\\.S|U\\.K';
const SENTENCE_SPLIT = new RegExp(`(?<!\\b(?:${ABBREVIATIONS})\\.)(?<=[.!?])\\s+`);

function splitSentences(text) {
  return text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

function classify(sentence) {
  if (UNCERTAIN_PATTERNS.some((re) => re.test(sentence))) {
    return { memory_type: 'open_question', certainty: 'uncertain' };
  }
  if (DEADLINE_KEYWORDS.test(sentence) && DATE_PATTERN.test(sentence)) {
    return { memory_type: 'deadline', certainty: 'confirmed' };
  }
  if (DECISION_PATTERNS.some((re) => re.test(sentence))) {
    return { memory_type: 'decision', certainty: 'confirmed' };
  }
  if (REQUIREMENT_PATTERNS.some((re) => re.test(sentence))) {
    return { memory_type: 'requirement', certainty: 'confirmed' };
  }
  if (PREFERENCE_PATTERNS.some((re) => re.test(sentence))) {
    return { memory_type: 'preference', certainty: 'probable' };
  }
  return null;
}

function extractCandidatesRuleBased(messages) {
  const candidates = [];
  for (const msg of messages) {
    for (const sentence of splitSentences(msg.content)) {
      const cls = classify(sentence);
      if (!cls) continue;
      candidates.push({ ...cls, content: sentence, sourceMessage: msg, createdBy: 'rule_based_extractor' });
    }
  }
  return candidates;
}

// --- LLM-based extraction (active once ANTHROPIC_API_KEY is set) -----------
//
// Prompts Claude to read the whole conversation and propose candidates
// directly, instead of pattern-matching trigger words. The one invariant
// carried over unchanged from the rule-based extractor — and the one thing
// this file must never relax, per the README — is that every candidate's
// quote has to be verified against the source message text; an LLM's claimed
// quote is untrusted input until it passes validateLLMCandidate() below.

export const MEMORY_TYPES = new Set(['decision', 'requirement', 'preference', 'deadline', 'fact', 'open_question']);
// Note: 'speculative' is deliberately NOT a valid value here (and isn't in
// the memories.certainty CHECK constraint either, see db/migrations/
// 001_init.sql) — a candidate the model itself isn't confident belongs in
// memory should be omitted entirely, never inserted with a hedge label.
export const CERTAINTY_VALUES = new Set(['confirmed', 'probable', 'uncertain', 'disputed']);

// How close a quote has to be to some sentence in the source message to count
// as "near-verbatim" when it isn't an exact substring (e.g. the model closed
// with a period the speaker left off, or normalized a smart quote). This is
// intentionally strict-ish — it's a tolerance for trivial transcription
// noise, not a license to paraphrase. Tune against real output if it proves
// too strict/loose in practice; there was no live API key available to
// calibrate it when this was written.
const NEAR_VERBATIM_THRESHOLD = 0.6;

function normalizeForCompare(s) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Exported for testing. Exact substring match (after normalizing whitespace/
// smart quotes) is the primary path; trigram similarity against the source
// message's own sentences is the fallback for trivial noise. A quote that
// doesn't clear either bar is rejected outright — this is the check the
// README says must never be relaxed.
export async function quoteIsVerbatimOrNearVerbatim(quote, messageContent) {
  if (!quote || !messageContent) return false;
  const normQuote = normalizeForCompare(quote);
  const normContent = normalizeForCompare(messageContent);
  if (normContent.includes(normQuote)) return true;

  const sentences = splitSentences(messageContent);
  if (sentences.length === 0) return false;
  const { rows } = await query(`SELECT max(similarity($1, s)) AS score FROM unnest($2::text[]) AS s`, [
    quote,
    sentences,
  ]);
  return Number(rows[0]?.score ?? 0) >= NEAR_VERBATIM_THRESHOLD;
}

// Exported for testing. Validates one raw candidate object as returned by the
// model's JSON against: (a) memory_type/certainty are in the fixed enums —
// this is what actually blocks a model-invented value like "speculative",
// since it never even reaches the DB's CHECK constraint; (b) message_id
// resolves to a real message in *this* conversation; (c) the quote clears
// quoteIsVerbatimOrNearVerbatim against that specific message's content, not
// just "somewhere in the conversation" (a quote that's verbatim from the
// WRONG message is still a fabricated citation).
export async function validateLLMCandidate(raw, messageById) {
  if (!raw || typeof raw !== 'object') return null;
  if (!MEMORY_TYPES.has(raw.memory_type)) return null;
  if (!CERTAINTY_VALUES.has(raw.certainty)) return null;
  const sourceMessage = messageById.get(raw.message_id);
  if (!sourceMessage) return null;
  const quote = typeof raw.quote === 'string' ? raw.quote.trim() : '';
  if (!quote) return null;
  if (!(await quoteIsVerbatimOrNearVerbatim(quote, sourceMessage.content))) return null;
  return { memory_type: raw.memory_type, certainty: raw.certainty, content: quote, sourceMessage, createdBy: 'llm_extractor' };
}

const EXTRACTION_SYSTEM_PROMPT = `You extract durable project-memory candidates from a conversation transcript. Each message is labeled with its message_id.

Only propose a candidate when the transcript CLEARLY states one of:
- decision: a choice the team has actually settled on (not merely being considered)
- requirement: a hard constraint ("must", "never", "always", "cannot", "required")
- preference: a stated preference that is not yet a settled decision
- deadline: a concrete date or deadline
- fact: a durable fact about the project that isn't a decision, requirement, or preference
- open_question: something explicitly undecided, still being discussed, or reversed — hedged language like "leaning toward", "considering", "might", "not decided yet", "seems better", "we'll revisit this" belongs here, NEVER classified as a decision or requirement just because it also contains decision-shaped words

Rules:
- "quote" must be copied EXACTLY, character-for-character, from the content of the message named by "message_id" — never paraphrase, summarize, translate, or fix its punctuation/typos. If you cannot quote a claim verbatim, leave it out.
- "message_id" must be the exact id of the message the quote was copied from.
- "certainty" must be exactly one of: confirmed, probable, uncertain, disputed. Never invent another value (e.g. never use "speculative"). If you are not confident a claim belongs in memory at all, omit it rather than defaulting to a low-confidence label.
- One candidate per distinct claim — do not extract restatements of the same fact twice, even if it's repeated across messages.
- If nothing in the transcript is worth remembering, return an empty array.

Respond with ONLY a JSON array, no prose, no markdown code fences. Each element:
{"message_id": "...", "quote": "...", "memory_type": "...", "certainty": "..."}`;

function buildTranscript(messages) {
  return messages
    .map((m) => `message_id=${m.id} role=${m.role}\n${m.content}`)
    .join('\n\n---\n\n');
}

function parseJSONArray(raw) {
  // Claude sometimes wraps JSON in a markdown fence even when told not to —
  // strip one if present rather than failing on it.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  const value = JSON.parse(cleaned);
  if (!Array.isArray(value)) throw new Error('extraction response was not a JSON array');
  return value;
}

async function extractCandidatesViaLLM(messages) {
  if (messages.length === 0) return [];
  const raw = await complete({
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildTranscript(messages) }],
    maxTokens: 4096,
  });
  return parseJSONArray(raw);
}

/**
 * Extract candidate memories from a conversation and insert them as
 * status='proposed' with structured evidence. Nothing here is auto-activated —
 * a human confirms via `memory confirm` before a candidate becomes 'active'
 * project memory (see memory/lifecycle.js).
 *
 * Uses real LLM extraction when ANTHROPIC_API_KEY is configured, falling back
 * to the deterministic rule-based extractor if no key is set OR if the LLM
 * call/parse fails for any reason (invalid key, network error, malformed
 * JSON, ...) — this command must degrade, never crash, the same way `ask`'s
 * answer generation does in cli.js.
 *
 * `actingUserId` must be able to read the conversation (enforced by
 * listMessages itself) AND have write access to the project, since this
 * creates new project-level memory rows.
 */
export async function extractCandidates(conversationId, actingUserId) {
  const messages = await listMessages(conversationId, actingUserId);
  const { rows: convoRows } = await query(
    `SELECT project_id, owner_id FROM conversations WHERE id = $1`,
    [conversationId]
  );
  if (convoRows.length === 0) throw new Error(`Conversation ${conversationId} not found`);
  const { project_id: projectId, owner_id: ownerId } = convoRows[0];
  await assertProjectWrite(projectId, actingUserId);

  let candidates;
  if (llmAvailable()) {
    try {
      const messageById = new Map(messages.map((m) => [m.id, m]));
      const rawCandidates = await extractCandidatesViaLLM(messages);
      candidates = [];
      for (const rawCandidate of rawCandidates) {
        const validated = await validateLLMCandidate(rawCandidate, messageById);
        if (validated) candidates.push(validated);
      }
    } catch (err) {
      console.error(
        `LLM extraction failed (${err.message}) — falling back to the rule-based extractor for this run.`
      );
      candidates = extractCandidatesRuleBased(messages);
    }
  } else {
    candidates = extractCandidatesRuleBased(messages);
  }

  // The whole batch runs in one transaction, with the conversation row
  // locked for its duration (the same pattern postMessage.js uses for
  // message-sequence ordering). This closes two gaps that existed when each
  // insert was its own statement: (a) a memory could be left with no
  // evidence if the process crashed between the two inserts, and (b) two
  // concurrent extractCandidates() calls on the SAME conversation could both
  // pass the duplicate check before either had inserted, creating duplicate
  // proposals. UNIQUE(message_id, quote) on memory_evidence (migration 005)
  // is the hard backstop if this lock is ever bypassed by a different code
  // path — note that constraint means a candidate can never be re-proposed
  // once ANY memory (even a since-rejected one) has cited that exact quote
  // from that exact message; there is currently no "un-reject" operation.
  const created = await withTransaction(async (client) => {
    await client.query(`SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, [conversationId]);

    const createdInner = [];
    for (const c of candidates) {
      // Both extractor paths hand us only already-validated candidates by
      // this point (rule-based: verbatim by construction; LLM: verified by
      // validateLLMCandidate above) — this is just a cheap non-empty guard,
      // not re-doing the validation.
      if (!c.content || !c.sourceMessage) continue;

      const { rows: dupRows } = await client.query(
        `SELECT 1 FROM memory_evidence WHERE message_id = $1 AND quote = $2`,
        [c.sourceMessage.id, c.content]
      );
      if (dupRows.length > 0) continue;

      const { rows } = await client.query(
        `INSERT INTO memories
           (project_id, conversation_id, owner_id, memory_type, content, status, certainty, origin, created_by)
         VALUES ($1, $2, $3, $4, $5, 'proposed', $6, 'inferred_from_multiple_sources', $7)
         RETURNING *`,
        [projectId, conversationId, ownerId, c.memory_type, c.content, c.certainty, c.createdBy ?? 'rule_based_extractor']
      );
      const memory = rows[0];

      await client.query(
        `INSERT INTO memory_evidence (memory_id, source_type, conversation_id, message_id, quote, evidence_role)
         VALUES ($1, 'message', $2, $3, $4, 'supports')`,
        [memory.id, conversationId, c.sourceMessage.id, c.content]
      );

      await recordAudit(client, {
        projectId,
        actorId: actingUserId,
        action: 'memory_extracted',
        entityType: 'memory',
        entityId: memory.id,
        detail: { memory_type: memory.memory_type, extractor: c.createdBy ?? 'rule_based_extractor' },
      });

      createdInner.push(memory);
    }
    return createdInner;
  });

  // Embedding is best-effort and deliberately OUTSIDE the transaction above
  // (same reasoning as uploadFile in files.js and postMessage in
  // conversations.js) — these memories are already committed and usable via
  // keyword/trigram search whether or not this succeeds. Only runs once the
  // optional 007_message_memory_embeddings.optional.sql migration has added
  // the column; see scripts/backfill_embeddings.js for memories created
  // before that (or before ANTHROPIC_API_KEY/embeddings were configured).
  if (created.length > 0 && embeddingsAvailable() && (await hasEmbeddingColumn('memories'))) {
    try {
      const vectors = await embed(created.map((m) => m.content));
      for (let i = 0; i < created.length; i++) {
        if (vectors[i]) {
          await query(`UPDATE memories SET embedding = $1::vector WHERE id = $2`, [
            `[${vectors[i].join(',')}]`,
            created[i].id,
          ]);
        }
      }
    } catch (err) {
      console.warn(`Embedding request failed (${err.message}) — memories stored without embeddings.`);
    }
  }

  return created;
}
