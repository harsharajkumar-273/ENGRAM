#!/usr/bin/env node
// Recreates the worked examples from the architecture discussion as a
// self-verifying regression test — not just a demo with eyeballed output.
// Every invariant below is a real assertion: if extraction regresses (e.g.
// starts fabricating a decision from "leaning toward" language, or the
// permission filter stops enforcing membership), this script throws and
// exits non-zero, not just prints a warning that's easy to miss.
import { createProject, addMember } from '../src/projects.js';
import { createConversation, postMessage } from '../src/conversations.js';
import { extractCandidates } from '../src/memory/extract.js';
import { confirmMemory, supersedeMemory, getMemoryWithEvidence } from '../src/memory/lifecycle.js';
import { buildContext, formatContext } from '../src/memory/context.js';
import { closePool } from '../src/db.js';

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  PASS: ${message}`);
}

async function main() {
  const project = await createProject('Amplify V1', 'alice');
  await addMember(project.id, 'alice', 'bob', 'editor');
  console.log(`Project: ${project.name} (${project.id})`);
  console.log('Members: alice (owner), bob (editor). carol is intentionally NOT a member.\n');

  const productStrategy = await createConversation(project.id, 'alice', { title: 'Product strategy' });
  await postMessage(productStrategy.id, 'alice', {
    content: 'We will use OAuth for third-party authentication.',
  });

  const dbDesign = await createConversation(project.id, 'bob', { title: 'Database design' });
  await postMessage(dbDesign.id, 'bob', {
    content:
      'We discussed PostgreSQL and DynamoDB. PostgreSQL seems better for the MVP. No final decision yet. We will revisit this next week.',
  });

  const launchPlanning = await createConversation(project.id, 'alice', { title: 'Launch planning' });
  await postMessage(launchPlanning.id, 'alice', { content: 'The launch date is November 15.' });

  const execReview = await createConversation(project.id, 'alice', { title: 'Executive Review' });
  await postMessage(execReview.id, 'alice', { content: 'We moved the launch date to December 1.' });

  console.log('--- Extracting candidates from each conversation ---');
  const c1 = await extractCandidates(productStrategy.id, 'alice');
  const c2 = await extractCandidates(dbDesign.id, 'bob');
  const c3 = await extractCandidates(launchPlanning.id, 'alice');
  const c4 = await extractCandidates(execReview.id, 'alice');
  for (const c of [...c1, ...c2, ...c3, ...c4]) {
    console.log(`  [${c.memory_type}] (${c.status}) ${c.content}`);
  }

  console.log('\n--- Extraction invariants ---');
  const oauthDecision = c1.find((m) => m.memory_type === 'decision');
  assert(Boolean(oauthDecision), 'OAuth statement was extracted as a decision candidate');

  const openQ = c2.find((m) => m.memory_type === 'open_question');
  assert(Boolean(openQ), 'DB discussion was extracted as an open_question');

  const wronglyDecided = c2.find((m) => m.memory_type === 'decision');
  assert(!wronglyDecided, 'no decision was fabricated from "leaning toward" / "no final decision yet" language');

  const nov15 = c3.find((m) => m.memory_type === 'deadline');
  assert(Boolean(nov15), 'Nov 15 launch date was extracted as a deadline candidate');

  const dec1 = c4.find((m) => m.memory_type === 'deadline');
  assert(Boolean(dec1), 'Dec 1 launch date was extracted as a deadline candidate');

  console.log('\n--- Evidence invariant ---');
  const oauthWithEvidence = await getMemoryWithEvidence(oauthDecision.id, 'alice');
  assert(oauthWithEvidence.evidence.length > 0, 'OAuth decision has at least one evidence record');
  assert(
    oauthWithEvidence.evidence[0].quote === 'We will use OAuth for third-party authentication.',
    'OAuth decision evidence quote matches the source sentence verbatim'
  );

  console.log('\n--- Confirming the OAuth decision and the Nov 15 date ---');
  await confirmMemory(oauthDecision.id, 'alice');
  await confirmMemory(nov15.id, 'alice');

  console.log("--- Superseding Nov 15 with Executive Review's Dec 1 date ---");
  await confirmMemory(dec1.id, 'alice');
  const { old: supersededNov15, new: activeDec1 } = await supersedeMemory(nov15.id, dec1.id, 'alice');

  console.log('\n--- Lifecycle invariants ---');
  assert(supersededNov15.status === 'superseded', 'Nov 15 memory is now status=superseded (not deleted)');
  assert(activeDec1.status === 'active', 'Dec 1 memory is now status=active');
  assert(activeDec1.supersedes_memory_id === nov15.id, 'Dec 1 memory records supersedes_memory_id -> Nov 15');

  console.log('\n--- alice asks: "What remains before we can launch?" ---');
  const ctxAlice = await buildContext(project.id, 'alice', 'What remains before we can launch?');
  console.log(formatContext(ctxAlice));

  console.log('\n--- Retrieval invariants ---');
  assert(!ctxAlice.denied, 'alice (project member) is not denied access');
  const activeIds = ctxAlice.activeMemories.map((m) => m.id);
  assert(activeIds.includes(oauthDecision.id), 'active memory set includes the OAuth decision');
  assert(activeIds.includes(dec1.id), 'active memory set includes the Dec 1 deadline');
  assert(!activeIds.includes(nov15.id), 'active memory set excludes the superseded Nov 15 deadline by default');

  console.log('\n--- carol (NOT a project member) asks the same question ---');
  const ctxCarol = await buildContext(project.id, 'carol', 'What remains before we can launch?');
  assert(ctxCarol.denied === true, 'carol (non-member) is denied access — permission filtering works');

  console.log(`\nAll invariants passed. Project ID: ${project.id}`);
  console.log('Try: node src/cli.js memory list ' + project.id);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
