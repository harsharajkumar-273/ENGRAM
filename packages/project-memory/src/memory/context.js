import { listMemories } from './lifecycle.js';
import { hybridSearch } from '../retrieval.js';

// Assembles the "safer architecture" prompt shape: active memories with their
// evidence, kept structurally separate from retrieved raw sources. Never
// returns a superseded/rejected/proposed memory as if it were active, and
// never returns a memory whose evidence the caller can't actually see (e.g.
// it only cites a private conversation they aren't in) — that memory is
// dropped from this context entirely rather than shown unsupported.
// listMemories() already applies this same evidence-visibility filter (see
// memory/lifecycle.js), so there is nothing further to filter here.
export async function buildContext(projectId, userId, questionText) {
  const { sources, memories: matchedMemories, denied } = await hybridSearch(projectId, userId, questionText);
  if (denied) {
    return { denied: true, activeMemories: [], matchedMemories: [], sources: [] };
  }

  const activeMemories = await listMemories(projectId, userId, { status: 'active' });

  return { denied: false, activeMemories, matchedMemories, sources };
}

export function formatContext(ctx) {
  if (ctx.denied) {
    return 'Access denied: you are not a member of this project.';
  }

  const lines = [];
  lines.push('Active project memory:');
  if (ctx.activeMemories.length === 0) {
    lines.push('  (none)');
  }
  for (const m of ctx.activeMemories) {
    lines.push(`  [${m.memory_type}] ${m.content}`);
    for (const e of m.evidence) {
      const loc = [e.conversation_id && `conversation ${e.conversation_id}`, e.message_id && `message ${e.message_id}`]
        .filter(Boolean)
        .join(', ');
      lines.push(`    ${e.evidence_role}: ${loc} — "${e.quote}"`);
    }
    if (m.supersedes_memory_id) {
      lines.push(`    (supersedes memory ${m.supersedes_memory_id} — see 'memory show' to inspect)`);
    }
  }

  lines.push('');
  lines.push('Relevant sources:');
  if (ctx.sources.length === 0) {
    lines.push('  (none)');
  }
  for (const s of ctx.sources) {
    if (s.kind === 'message') {
      lines.push(`  [message] ${s.conversation_title ?? s.conversation_id}: "${s.content}"`);
    } else {
      lines.push(`  [file] ${s.filename}: "${String(s.text).slice(0, 200)}"`);
    }
  }

  return lines.join('\n');
}
