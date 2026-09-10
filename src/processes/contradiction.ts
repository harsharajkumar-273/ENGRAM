// ============================================
// Engram NLI Contradiction Engine & Resolution
// ============================================

import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { 
  Memory, 
  ExtractedMemory, 
  ContradictionEvaluation, 
  ContradictionRecord,
  Message 
} from '../core/types.js';
import type { LLMProvider } from '../providers/interface.js';
import type { MemoryStore } from '../storage/memory-store.js';

const CONTRADICTION_SCHEMA = {
  type: 'object',
  properties: {
    evaluations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          old_memory_id: { type: 'string' },
          classification: { 
            type: 'string', 
            enum: ['CONTRADICTION', 'ENTAILMENT', 'NEUTRAL'],
            description: 'CONTRADICTION if new fact directly invalidates/replaces old fact; ENTAILMENT if compatible/reinforcing; NEUTRAL if unrelated'
          },
          confidence: { type: 'number', description: '0.0 to 1.0 confidence score' },
          reasoning: { type: 'string', description: 'Brief rationale explaining the logical relationship' }
        },
        required: ['old_memory_id', 'classification', 'confidence', 'reasoning']
      }
    }
  },
  required: ['evaluations']
};

const SYSTEM_PROMPT = `You are the Natural Language Inference (NLI) Contradiction Detection Engine of Engram.
Your mission is to compare a newly stated fact against prior recorded memories about the user and detect when facts change or are superseded.

CLASSIFICATION RULES:
1. CONTRADICTION:
   - The new fact renders the old fact obsolete, false, or mutually exclusive.
   - Examples:
     * Old: "User lives in Berlin" vs New: "User relocated to Lisbon" -> CONTRADICTION (A person can only primarily reside in one city).
     * Old: "User is a vegetarian" vs New: "User had a prime steak dinner" -> CONTRADICTION (Dietary practice conflict).
     * Old: "User works at Google as a software engineer" vs New: "User quit tech to open a bakery" -> CONTRADICTION (Occupation change).
     * Old: "User is married to Sarah" vs New: "User finalized divorce last week" -> CONTRADICTION (Relationship status change).

2. ENTAILMENT (NOT a contradiction):
   - The new fact is consistent with, refines, or adds detail to the old fact.
   - Examples:
     * Old: "User works at Google" vs New: "User works on the Google Maps backend team" -> ENTAILMENT (Refinement).
     * Old: "User likes Italian food" vs New: "User loves homemade gnocchi" -> ENTAILMENT (Subset/preference).

3. NEUTRAL (NOT a contradiction):
   - The two facts discuss independent topics or co-occurring states.
   - Examples:
     * Old: "User lives in Berlin" vs New: "User is traveling to Tokyo for vacation" -> NEUTRAL (Vacation does not change residence).
     * Old: "User owns a Golden Retriever" vs New: "User adopted a kitten" -> NEUTRAL (Can have multiple pets).

Be conservative and precise: only mark CONTRADICTION when the new fact genuinely supersedes or invalidates the prior fact.`;

/**
 * Evaluates whether a new memory contradicts any candidate existing memories using NLI classification.
 */
export async function detectContradictions(
  newMemory: ExtractedMemory | Memory,
  candidates: Memory[],
  llm: LLMProvider
): Promise<ContradictionEvaluation[]> {
  if (candidates.length === 0) return [];

  const candidatesText = candidates.map(c => 
    `- [ID: ${c.id}] "${c.content}" (recorded on: ${c.created_at})`
  ).join('\n');

  const promptMessages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Incoming New Fact:
"${newMemory.content}"

Prior Recorded Memories to Evaluate Against:
${candidatesText}

Evaluate each prior memory against the incoming new fact and classify as CONTRADICTION, ENTAILMENT, or NEUTRAL.`
    }
  ];

  try {
    const result = await llm.chatJSON<{ evaluations: ContradictionEvaluation[] }>(
      promptMessages,
      CONTRADICTION_SCHEMA,
      { temperature: 0.1 }
    );

    if (!result || !Array.isArray(result.evaluations)) {
      return [];
    }

    return result.evaluations.filter(ev => 
      candidates.some(c => c.id === ev.old_memory_id) &&
      ['CONTRADICTION', 'ENTAILMENT', 'NEUTRAL'].includes(ev.classification)
    );
  } catch (err) {
    console.warn('[Engram Contradiction] NLI classification failed:', err);
    return [];
  }
}

/**
 * Resolves confirmed contradictions:
 * 1. Marks older memory as 'superseded' with superseded_by = newMemory.id
 * 2. Transfers knowledge by preserving recall count
 * 3. Logs an audit record in the contradictions table
 */
export function resolveContradictions(
  newMemory: Memory,
  evaluations: ContradictionEvaluation[],
  memoryStore: MemoryStore,
  db: Database.Database,
  nowIso: string,
  minConfidence = 0.7
): ContradictionRecord[] {
  const resolvedRecords: ContradictionRecord[] = [];

  const insertContradictionStmt = db.prepare(`
    INSERT INTO contradictions (
      id, old_memory_id, new_memory_id, old_content, new_content, confidence, reasoning, detected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const ev of evaluations) {
    if (ev.classification === 'CONTRADICTION' && ev.confidence >= minConfidence) {
      const oldMem = memoryStore.getById(ev.old_memory_id);
      if (oldMem && oldMem.status === 'active') {
        const recordId = uuidv4();

        const transaction = db.transaction(() => {
          // Supersede the outdated memory
          memoryStore.updateStatus(oldMem.id, 'superseded', newMemory.id);

          // Transfer knowledge / recall count to new memory
          if (oldMem.recall_count > 0) {
            newMemory.recall_count = Math.max(newMemory.recall_count, oldMem.recall_count + 1);
            memoryStore.updateRecallStats(newMemory.id, nowIso);
          }

          // Record in audit log
          insertContradictionStmt.run(
            recordId,
            oldMem.id,
            newMemory.id,
            oldMem.content,
            newMemory.content,
            ev.confidence,
            ev.reasoning,
            nowIso
          );
        });

        transaction();

        resolvedRecords.push({
          id: recordId,
          old_memory_id: oldMem.id,
          new_memory_id: newMemory.id,
          old_content: oldMem.content,
          new_content: newMemory.content,
          confidence: ev.confidence,
          reasoning: ev.reasoning,
          detected_at: nowIso
        });
      }
    }
  }

  return resolvedRecords;
}
