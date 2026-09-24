# Project Memory Prototype

An evidence-backed project-memory system: raw conversations/files are the
immutable source of truth; memories and decisions are structured, citation-backed
claims *derived from* them — never the other way around, and never derived from
a summary. See the design writeup in the session's plan for the full rationale;
this README covers running and extending the code.

## What's here vs. deferred

**Implemented:** projects + role-based membership (owner/editor/viewer),
conversations (with visibility/ACL, split into read vs. write access), messages
(with concurrency-safe ordering), file upload with hashing/dedup + text
extraction + chunking, hybrid keyword + semantic search (pg_trgm + optional
pgvector, across file chunks, messages, AND memories) with permission
filtering done in SQL, an evidence-backed `memories` + `memory_evidence` model
with per-viewer evidence visibility filtering, LLM-based candidate extraction
(deterministic rule-based fallback) with quote validation, a full lifecycle
(proposed → active/rejected → superseded) guarded by a centralized
authorization model, transactions around multi-statement writes, an
administrative audit log covering membership and memory/file changes, and an
automated test suite (`npm test`).

**Deferred (see plan for phasing):** conversation summaries, OCR/audio/video,
a real async job queue (everything here runs synchronously), further
production hardening (retention policies, load testing). LLM extraction and
vector embeddings are wired up but inactive until `ANTHROPIC_API_KEY`/an
embeddings provider key are configured (see "LLM-based extraction" and
"Semantic (vector) search" below) — neither has been run end-to-end with a
live key yet, see those sections for what to verify first. An administrative
audit log (see "Audit log" below) is implemented, not deferred.

## Setup

```bash
# 1. Database (already created for this prototype: project_memory_proto)
createdb project_memory_proto   # skip if it already exists

# 2. Install pgvector, then apply the vector migration (optional — the app
#    works without it, using keyword-only search until this is done):
brew install pgvector
psql project_memory_proto -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 3. Install dependencies
npm install

# 4. Run migrations (idempotent — safe to rerun). 002_vector.optional.sql is
#    marked optional by filename convention: it only succeeds once pgvector
#    is installed, and its failure does NOT set a non-zero exit code or
#    block later, required migrations (003-006 apply regardless). A failing
#    REQUIRED migration still does set a non-zero exit code — `npm test`
#    depends on that distinction (see step 6).
npm run migrate

# 5. Seed the demo scenario
npm run seed

# 6. Run the automated test suite (runs migrate first via `&&`, so a failing
#    REQUIRED migration correctly stops before running any tests — only
#    002_vector.optional.sql's expected failure doesn't block this; zero new
#    test dependencies — uses Node's built-in node:test/node:assert)
npm test
```

## CLI

Every mutating command takes an acting user — either an existing flag that
already served that role (`--owner`, `--author`), or a new `--actor` flag.
Every one of these is authorization-checked (see "Authorization model" below);
there is no back door that skips the check.

```
node src/cli.js project create <name> --owner <userId>
node src/cli.js member add <projectId> <userId> --role owner|editor|viewer --actor <userId>   # actor must be the project owner
node src/cli.js conversation create <projectId> --title "..." --owner <userId> [--visibility private|project]  # owner must have project write access
node src/cli.js message add <conversationId> --author <userId> [--role user|assistant] --content "..."          # author must have conversation write access
node src/cli.js file upload <projectId> <filePath> --owner <userId> [--visibility private|project]              # owner must have project write access
node src/cli.js extract <conversationId> --actor <userId>          # actor must read the conversation + write the project
node src/cli.js memory list <projectId> --actor <userId> [--status proposed|active|superseded|rejected]
node src/cli.js memory show <memoryId> --actor <userId>
node src/cli.js memory confirm <memoryId> --actor <userId>
node src/cli.js memory reject <memoryId> --actor <userId>
node src/cli.js memory supersede <oldMemoryId> <newMemoryId> --actor <userId>   # both memories must be in the same project
node src/cli.js memory edit <memoryId> --actor <userId> --content "..."
node src/cli.js memory delete <memoryId> --actor <userId>
node src/cli.js ask <projectId> <userId> "<question>"
```

## LLM-based extraction

`src/memory/extract.js` uses real Claude extraction (via `src/llm.js`'s
`complete()` wrapper over the Anthropic Messages API) whenever
`ANTHROPIC_API_KEY` is set in the environment. Claude reads the whole
conversation and proposes candidates directly as
`{ message_id, quote, memory_type, certainty }` JSON, instead of the
trigger-word pattern matching the earlier version used.

If `ANTHROPIC_API_KEY` isn't set, or the LLM call/response fails for any
reason (bad key, network error, malformed JSON, ...), extraction falls back
automatically to the original deterministic rule-based extractor — the same
"degrade to something useful, never crash" pattern `ask` already uses for
answer generation. This also means the test suite and CLI both still work
with zero network access and zero API key.

The one invariant that must never be relaxed, in either extractor, is quote
validation: every candidate's `quote` must be verbatim-present (or
near-verbatim — see `quoteIsVerbatimOrNearVerbatim()`, a trigram-similarity
check against the source message's own sentences) in the specific message
`message_id` points at. `validateLLMCandidate()` also rejects any
`memory_type`/`certainty` value outside the fixed enums before it can reach
the database — including a model that invents a value like `"speculative"`
instead of using one of `confirmed`/`probable`/`uncertain`/`disputed`, or
simply omitting a claim it isn't confident about (which is what it should do
instead). `test/llm-extraction.test.js` exercises this boundary directly
with fabricated "model output" objects, so it doesn't need an API key either.

**Not yet calibrated against real output**: the near-verbatim similarity
threshold (`NEAR_VERBATIM_THRESHOLD` in `extract.js`) and the extraction
prompt itself were written without a live `ANTHROPIC_API_KEY` available to
test against. Once you have a key, it's worth running `extract` against a
few real conversations and checking: (a) whether the threshold is too strict
(rejecting quotes Claude copied correctly but with trivial formatting
differences) or too loose (letting a paraphrase through), and (b) whether
the prompt's classification boundaries (e.g. decision vs. open_question)
match your judgment on real transcripts, the way the three existing
`extraction.test.js` cases pin the rule-based extractor's boundaries.

## Semantic (vector) search

Covers file chunks, messages, AND memories now — not just files. Each gets
its own optional migration and its own best-effort embed-at-write-time hook:

- `file_chunks.embedding` — `002_vector.optional.sql`; embedded in
  `uploadFile` (`src/files.js`).
- `messages.embedding` / `memories.embedding` —
  `007_message_memory_embeddings.optional.sql`; embedded in `postMessage`
  (`src/conversations.js`), `extractCandidates` and `editMemory`
  (`src/memory/extract.js` / `src/memory/lifecycle.js`).

Setup, once `brew install pgvector` has been run:

```bash
npm run migrate    # applies 002 and 007 (both optional — safe to rerun)
export OPENAI_API_KEY=...   # or whichever provider embed() in src/embeddings.js targets
npm run backfill    # embeds any existing rows written before the key/migration existed
```

`retrieval.js`'s `hybridSearch()` merges a vector leg into each of the three
keyword/trigram legs per-table, gated independently by
`hasEmbeddingColumn('file_chunks' | 'messages' | 'memories')` (see `db.js`) —
so it degrades correctly if only some of the migrations/backfills have run.
The merge is keyed (by chunk/message/memory id) rather than concatenated:
a row that matches on both keyword and vector search appears once, keeping
whichever similarity score is higher, not twice. Each vector leg also
requires cosine similarity > 0.3 (not just "closest of whatever rows have an
embedding") — without that floor, a project with only one embedded row would
have that row returned as the vector leg's top match regardless of whether
it is actually relevant, since ORDER BY ... LIMIT always returns *something*.
0.3 is an untested placeholder, picked to cleanly separate related-vs-unrelated
in `test/vector-search.test.js`'s synthetic one-hot vectors — recalibrate it
against your actual embeddings provider's real similarity distribution once
you have one (typical OpenAI text-embedding-3-small cosine similarities for
genuinely related text tend to run higher than intuition suggests; don't
assume 0.3 is well-tuned without checking).

**Local verification status**: pgvector migrations and all three synthetic
semantic-search tests pass against a live local Postgres instance. A real
embeddings provider has still not been exercised end-to-end. Before trusting
provider-backed search in front of users, run `npm run backfill` with a real
key, confirm `file_chunks`/`messages`/`memories` rows receive non-null
embeddings, and calibrate the similarity threshold against representative
project queries.

## Audit log

A separate, append-only record of who changed what the system treats as
true or who can see what — distinct from the `messages` table, which is
already an immutable record of conversation content (this project's core
design principle). Logging every message post to `audit_log` too would just
be a redundant copy of data that's already immutable; `audit_log` instead
covers the layer on top: membership changes and memory/file lifecycle
events.

**Schema**: `db/migrations/008_audit_log.sql` — required (not `.optional.`
like `002`/`007`), since it's pure Postgres with no external dependency.
`audit_log(project_id, actor_id, action, entity_type, entity_id, detail,
created_at)`. `entity_id` is nullable: some actions (adding a member) don't
have a single uuid to point at — `project_members`' key is composite — so
those put identifying detail in `detail` (a jsonb column) instead.

**Where entries get written** — `src/audit.js`'s `recordAudit(client, {...})`
is called from inside the SAME transaction as the change it records, so the
audit entry and the change commit or roll back together:

- `addMember` (`src/projects.js`) → `member_added_or_role_changed`
- `confirmMemory` / `rejectMemory` / `editMemory` (with before/after content)
  / `deleteMemory` / `supersedeMemory` (`src/memory/lifecycle.js`) →
  `memory_confirmed` / `memory_rejected` / `memory_edited` / `memory_deleted`
  / `memory_superseded`
- `extractCandidates`, once per memory created (`src/memory/extract.js`) →
  `memory_extracted`
- `uploadFile` (`src/files.js`) → `file_uploaded` or `file_upload_deduped`

**Reading it back** — `listAuditLogForUser(projectId, actingUserId, opts)`
applies the same `assertProjectRead` check as every other project read (any
member, not just owners, since this is visible provenance, not a privileged
control), then delegates to `listAuditLog(projectId, { limit, entityType,
actorId })`. Exposed via:

- CLI: `project-memory audit list <projectId> --actor <userId> [--limit N]
  [--entityType memory] [--actorId alice]`
- HTTP: `GET /api/projects/:id/audit?actor=<userId>&limit=&entityType=&actorId=`

**Not covered on purpose**: message posts (see above — already immutable via
`messages`), and read-only actions (`listMemories`, `ask`, etc.) — this is a
change log, not an access log.

**Verification status**: `test/audit.test.js` covers confirm/edit/addMember
writing the expected entries and a non-member being denied read access. These
tests run against live local Postgres as part of `npm test`.

## Authorization model

- **Roles**: `project_members.role` is `owner`/`editor`/`viewer`. `owner`/
  `editor` can write (create conversations, post messages, upload files,
  mutate memories); `viewer` is read-only. Only `owner` can manage membership
  (`addMember`).
- **Centralized checks**: `src/projects.js` exports `assertProjectRead` (any
  member), `assertProjectWrite` (owner/editor), `assertProjectOwner`.
  `src/conversations.js` exports the same split for conversations —
  `assertConversationRead`/`assertConversationWrite` — because a private
  conversation's `conversation_acl` can grant `read` without granting `write`;
  treating any ACL row as license to post was a real bug fixed here.
  `src/files.js` exports `canReadFile`. Every mutating function in
  `lifecycle.js`, `conversations.js`, `files.js`, `projects.js`, and
  `memory/extract.js` calls one of these — there is no code path that mutates
  data without going through a check.
- **Evidence visibility is separate from memory visibility, and applies
  EVERYWHERE a memory is read, not just through `ask`.** A memory can be
  project-scoped while its evidence cites a *private* conversation or file.
  `src/access.js`'s `attachVisibleEvidence(memories, userId)` filters each
  memory's evidence down to what `userId` can actually read. `listMemories`,
  `getMemoryWithEvidence`, `findPotentialConflicts`, `buildContext`, and
  `hybridSearch`'s memory arm all **drop** any memory with zero visible
  evidence — a claim is never shown if its citation can't be shown. This
  applies uniformly to management commands (`memory list`/`memory show`) too:
  an earlier version of this rule only applied it to `ask`, which meant a
  project member could still learn a private-derived memory's content through
  `memory list` even though `ask` correctly hid it. `getMemoryWithEvidence`
  returns `null` (indistinguishable from "not found") rather than a shell
  with empty evidence, so it doesn't leak the memory's existence either.
  **This applies to WRITES too, not just reads.** `loadMemoryForWrite`
  (used by confirm/reject/edit/delete/supersede) checks project write-role
  via `assertProjectWrite`, but an earlier version stopped there — an editor
  with general project write access could still confirm/edit/delete/
  supersede a memory whose evidence they couldn't even see, just by knowing
  (or guessing) its id. It now also calls `access.js`'s
  `assertMemoryVisible(memory, userId)`, which throws the same "not found"
  error `getMemoryWithEvidence` would if none of the memory's evidence is
  visible to that actor (memories with zero evidence rows at all are exempt
  from this gate — there's nothing to hide, and no current code path creates
  such a memory anyway).
- **Concurrency uses locking, not blind retry.** `postMessage` and
  `extractCandidates` both take `SELECT ... FOR UPDATE` on the conversation
  row inside a transaction before computing `COALESCE(MAX(...),0)+1` (message
  sequence numbers) or checking/inserting candidates — this serializes
  concurrent operations on the SAME conversation deterministically, while
  different conversations proceed fully in parallel. An earlier version
  instead retried a fixed number of times on a `UNIQUE` conflict with no
  backoff; that's a thundering herd and empirically failed about 1-in-5 runs
  at just 20 concurrent writers. `test/concurrency.test.js` repeats the race
  across several trials at a higher N specifically to catch this kind of
  regression, since a single lucky pass proves nothing. The `UNIQUE`
  constraints (migrations 003, 005) remain as defense-in-depth — they should
  never actually fire now that the lock is in place.
- **Extraction is atomic and idempotent under concurrency.** `extractCandidates`
  runs its whole batch (duplicate-check + memory insert + evidence insert, per
  candidate) inside one transaction, under the same conversation-row lock
  described above — a crash mid-batch can no longer leave a memory with no
  evidence, and two concurrent extraction calls on the same conversation can
  no longer both pass the duplicate check before either commits.
  `UNIQUE(message_id, quote) WHERE evidence_role = 'supports'` (migration 005)
  is the hard backstop. It's scoped to `'supports'` specifically because
  `supersedeMemory` legitimately copies evidence forward as `'supersedes'`,
  reusing the same `(message_id, quote)` pair on purpose — an earlier version
  of this constraint wasn't scoped and broke that copy.
- **File deduplication respects ownership/visibility.** Dedup used to be keyed
  only on `(project_id, sha256)`, so Bob uploading bytes identical to Alice's
  *private* file silently reused her record — inheriting her `owner_id` and
  visibility. Now: project-visible files still dedup across the whole project
  (anyone there can already see it either way); private files dedup only
  within the *same* uploader's own prior private uploads (migration 006,
  enforced via partial unique indexes, not just application logic). The
  underlying bytes are still deduplicated at the storage level regardless —
  only the logical `files` record (which carries ownership/visibility) is
  now scoped correctly. See `test/file-dedup.test.js`.
- **Transactions**: `createProject`, `postMessage`, `extractCandidates`,
  `supersedeMemory`, and `uploadFile`'s DB writes each run inside a single
  `withTransaction` (`src/db.js`). Embedding calls are deliberately kept
  *outside* the transaction — they're network I/O and already best-effort
  (see `embeddingsAvailable()`/`hasEmbeddingColumn()`), so holding a DB
  transaction open across them would be the wrong tradeoff.

## Design notes

- **No separate `decisions` table.** Decisions are `memories` with
  `memory_type = 'decision'` — avoids modeling the same "evidence-backed claim"
  concept twice.
- **No `users` table.** User identity is a free-text id (e.g. `"alice"`) for
  this prototype; a real system would replace the `text` user columns with a
  foreign key.
- **Permission filtering happens in SQL** wherever a query returns multiple
  rows (`retrieval.js`'s project membership / conversation visibility / file
  visibility conditions) — not as a post-hoc filter in JavaScript after
  fetching broadly. Single-row lookups (e.g. a memory's evidence) are
  filtered in application code via `access.js` because the visibility rule
  spans two different source tables (conversations and files) per evidence
  row; see "Authorization model" above.
- **Nothing supersedes automatically.** `memory/lifecycle.js`'s
  `supersedeMemory()` is only ever called explicitly (CLI command or seed
  script) and requires both memories to be in the *same* project;
  `findPotentialConflicts()` only *surfaces* same-type, similar-content active
  memories for a human to resolve.
- **Deletion cascades fully.** Every table under a project — memberships,
  conversations, messages, files, file versions/chunks, memories, and memory
  evidence's direct pointers back to conversations/messages/files/file_chunks
  — cascades from `projects` (migration 004 closed a gap where evidence rows
  blocked deleting the conversation/file they cited). `DELETE FROM projects
  WHERE id = $1` removes everything underneath it, which is what the test
  suite's cleanup relies on.
- **Object storage** is the local `storage/` directory (files named by SHA-256)
  standing in for S3 — `files.object_key` is a relative path, so a real
  deployment can swap the read/write in `src/files.js` for an S3 client
  without changing the schema.
- **A rejected candidate can no longer be re-proposed.** Once any memory
  (including a since-rejected one) has cited a given `(message, quote)` pair,
  `UNIQUE(message_id, quote) WHERE evidence_role = 'supports'` means that
  exact quote can never back a second `'supports'` row. This is a deliberate
  tradeoff for the hard idempotency guarantee — there's currently no
  "un-reject" operation; to reconsider a rejected candidate, edit and confirm
  the existing rejected row rather than expecting re-extraction to recreate it.
- **Not yet done** (see the session's hardening plan for the full list): rate
  limiting, audit logging, refresh of `attachVisibleEvidence`'s per-row
  visibility checks into a single batched query (currently N+1 — fine at this
  scale, would need revisiting before real multi-tenant load).
