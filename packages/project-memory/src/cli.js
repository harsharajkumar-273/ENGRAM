#!/usr/bin/env node
import { createProject, addMember } from './projects.js';
import { createConversation, postMessage } from './conversations.js';
import { uploadFile } from './files.js';
import { extractCandidates } from './memory/extract.js';
import {
  listMemories,
  getMemoryWithEvidence,
  confirmMemory,
  rejectMemory,
  editMemory,
  deleteMemory,
  supersedeMemory,
  findPotentialConflicts,
} from './memory/lifecycle.js';
import { buildContext, formatContext } from './memory/context.js';
import { llmAvailable, complete } from './llm.js';
import { listAuditLogForUser } from './audit.js';
import { closePool } from './db.js';

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const [cmd, sub, ...rest] = args;

  if (cmd === 'project' && sub === 'create') {
    const { flags, positional } = parseFlags(rest);
    print(await createProject(positional[0], flags.owner));
    return;
  }

  if (cmd === 'member' && sub === 'add') {
    const { flags, positional } = parseFlags(rest);
    print(await addMember(positional[0], flags.actor, positional[1], flags.role || 'editor'));
    return;
  }

  if (cmd === 'conversation' && sub === 'create') {
    const { flags, positional } = parseFlags(rest);
    print(
      await createConversation(positional[0], flags.owner, {
        title: flags.title,
        visibility: flags.visibility || 'project',
      })
    );
    return;
  }

  if (cmd === 'message' && sub === 'add') {
    const { flags, positional } = parseFlags(rest);
    print(
      await postMessage(positional[0], flags.author, {
        role: flags.role || 'user',
        content: flags.content,
      })
    );
    return;
  }

  if (cmd === 'file' && sub === 'upload') {
    const { flags, positional } = parseFlags(rest);
    print(await uploadFile(positional[0], flags.owner, positional[1], { visibility: flags.visibility || 'project' }));
    return;
  }

  if (cmd === 'extract') {
    const conversationId = sub;
    const { flags } = parseFlags(rest);
    const created = await extractCandidates(conversationId, flags.actor);
    console.log(`Extracted ${created.length} proposed memory candidate(s):`);
    for (const m of created) console.log(`  ${m.id}  [${m.memory_type}]  ${m.content}`);
    return;
  }

  if (cmd === 'memory') {
    const { flags, positional } = parseFlags(rest);

    if (sub === 'list') {
      const rows = await listMemories(positional[0], flags.actor, { status: flags.status });
      for (const m of rows) console.log(`${m.id}  [${m.status}] [${m.memory_type}]  ${m.content}`);
      if (rows.length === 0) console.log('(no memories)');
      return;
    }
    if (sub === 'show') {
      print(await getMemoryWithEvidence(positional[0], flags.actor));
      return;
    }
    if (sub === 'confirm') {
      const m = await confirmMemory(positional[0], flags.actor);
      print(m);
      const conflicts = await findPotentialConflicts(m.project_id, m.id, flags.actor);
      if (conflicts.length) {
        console.log('Potential conflicts with existing active memories (not auto-resolved):');
        for (const c of conflicts) console.log(`  ${c.id}: ${c.content}`);
      }
      return;
    }
    if (sub === 'reject') {
      print(await rejectMemory(positional[0], flags.actor));
      return;
    }
    if (sub === 'supersede') {
      print(await supersedeMemory(positional[0], positional[1], flags.actor));
      return;
    }
    if (sub === 'edit') {
      print(await editMemory(positional[0], flags.actor, flags.content));
      return;
    }
    if (sub === 'delete') {
      print(await deleteMemory(positional[0], flags.actor));
      return;
    }
  }

  if (cmd === 'audit' && sub === 'list') {
    const { flags, positional } = parseFlags(rest);
    const rows = await listAuditLogForUser(positional[0], flags.actor, {
      limit: flags.limit,
      entityType: flags.entityType,
      actorId: flags.actorId,
    });
    for (const r of rows) {
      console.log(`${r.created_at.toISOString()}  ${r.actor_id.padEnd(12)} ${r.action.padEnd(28)} ${r.entity_type}${r.entity_id ? ':' + r.entity_id : ''}  ${JSON.stringify(r.detail)}`);
    }
    if (rows.length === 0) console.log('(no audit entries)');
    return;
  }

  if (cmd === 'ask') {
    const [projectId, userId, questionText] = [sub, rest[0], rest[1]];
    const ctx = await buildContext(projectId, userId, questionText);
    console.log(formatContext(ctx));
    if (!ctx.denied) {
      if (!llmAvailable()) {
        console.log(
          '\n(LLM answer generation skipped: ANTHROPIC_API_KEY not configured — showing assembled context only.)'
        );
      } else {
        // A configured key can still fail at call time (invalid/expired,
        // network issue, rate limit, wrong endpoint, ...) — that must degrade
        // to "context only", not crash the whole command.
        try {
          const answer = await complete({
            system:
              'Answer the question using ONLY the provided context. Cite the conversation or message for every claim you make. If the context does not contain the answer, say so explicitly.',
            messages: [{ role: 'user', content: `Context:\n${formatContext(ctx)}\n\nQuestion: ${questionText}` }],
          });
          console.log('\nAnswer:\n' + answer);
        } catch (err) {
          console.log(`\n(LLM answer generation failed (${err.message}) — showing assembled context only.)`);
        }
      }
    }
    return;
  }

  console.error(`Unknown command: ${args.join(' ')}`);
  console.error('See README.md for usage.');
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
