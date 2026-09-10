// ============================================
// Engram Procedural Memory Pattern Detection
// ============================================

import { v4 as uuidv4 } from 'uuid';
import type { Memory, Message } from '../core/types.js';
import type { LLMProvider } from '../providers/interface.js';
import type { MemoryStore } from '../storage/memory-store.js';

export interface ProceduralPattern {
  rule: string;
  confidence: number;
  category: 'code_preference' | 'communication_style' | 'workflow' | 'guidance';
}

const PROCEDURAL_SCHEMA = {
  type: 'object',
  properties: {
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rule: { type: 'string', description: 'Actionable behavioral instruction or persistent preference, e.g. "User prefers code examples in TypeScript with strict typing"' },
          confidence: { type: 'number', description: '0.0 to 1.0 confidence based on user behavior' },
          category: { type: 'string', enum: ['code_preference', 'communication_style', 'workflow', 'guidance'] }
        },
        required: ['rule', 'confidence', 'category']
      }
    }
  },
  required: ['patterns']
};

const PROCEDURAL_PROMPT = `You are the Procedural Memory Subsystem of Engram.
Your mission is to analyze recent conversational interactions and detect enduring interaction habits, output preferences, or procedural guidelines.

EXTRACT RULES LIKE:
- "User prefers concise, direct responses with minimal pleasantries"
- "User always prefers code implementations in TypeScript (ESM) rather than JavaScript"
- "User likes step-by-step verification commands after every change"
- "User prefers mathematical formulas written in LaTeX notation"

DO NOT EXTRACT:
- Episodic daily actions ("User had tea", "User ran a script")
- Basic biographical facts ("User lives in Lisbon")

Only extract consistent, high-confidence (>= 0.75) behavioral rules.`;

export async function detectProceduralPatterns(
  conversationTurns: Message[],
  memoryStore: MemoryStore,
  llm: LLMProvider,
  nowIso: string,
  userId = 'default_user'
): Promise<Memory[]> {
  if (conversationTurns.length < 4) return [];

  const conversationText = conversationTurns
    .map(t => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n');

  const messages: Message[] = [
    { role: 'system', content: PROCEDURAL_PROMPT },
    {
      role: 'user',
      content: `Analyze this conversational interaction history and extract qualifying procedural guidelines:\n\n${conversationText}`
    }
  ];

  try {
    const result = await llm.chatJSON<{ patterns: ProceduralPattern[] }>(
      messages,
      PROCEDURAL_SCHEMA,
      { temperature: 0.1 }
    );

    if (!result || !Array.isArray(result.patterns)) return [];

    const existingProcedural = memoryStore
      .getActiveByUser(userId)
      .filter(m => m.type === 'procedural');

    const createdMemories: Memory[] = [];

    for (const pattern of result.patterns) {
      if (pattern.confidence < 0.75 || !pattern.rule.trim()) continue;

      // Deduplication against existing procedural memories
      const isDuplicate = existingProcedural.some(
        m => m.content.toLowerCase().includes(pattern.rule.toLowerCase().slice(0, 30)) ||
             pattern.rule.toLowerCase().includes(m.content.toLowerCase().slice(0, 30))
      );

      if (!isDuplicate) {
        const mem: Memory = {
          id: uuidv4(),
          type: 'procedural',
          status: 'active',
          content: pattern.rule.trim(),
          source_turn_id: 'procedural_detection',
          importance: 0.85,
          emotional_weight: 0.1,
          recall_count: 0,
          base_half_life_hours: 2160, // 90 days base half-life
          strengthening_factor: 0.5,
          created_at: nowIso,
          last_recalled_at: nowIso,
          entities: [],
          superseded_by: null,
          consolidated_from: [],
          user_id: userId,
          session_id: 'procedural_session'
        };

        memoryStore.create(mem);
        createdMemories.push(mem);
      }
    }

    return createdMemories;
  } catch (err) {
    console.warn('[Engram Procedural] Pattern detection failed:', err);
    return [];
  }
}
