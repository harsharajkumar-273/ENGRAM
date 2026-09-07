// ============================================
// Engram LLM-Powered Memory Extraction Pipeline
// ============================================

import type { LLMProvider } from '../providers/interface.js';
import type { ExtractedMemory, ExtractionResult, Message, EntityType } from './types.js';
import { clampEmotionalWeight } from './emotional.js';

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Clear, self-contained statement of fact or event from third-person perspective (e.g., "User lives in Lisbon")' },
          type: { type: 'string', enum: ['episodic', 'semantic', 'procedural'], description: 'episodic for time-bound events, semantic for stable facts/preferences, procedural for interaction habits' },
          importance: { type: 'number', description: '0.0 to 1.0 based on decision-relevance, health/safety, and specificity' },
          emotional_weight: { type: 'number', description: '0.0 to 1.0 based on emotional intensity, life disruption, or personal depth' },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { 
                  type: 'string', 
                  enum: ['person', 'location', 'organization', 'topic', 'preference', 'allergen', 'dietary_preference', 'skill', 'relationship', 'event', 'product', 'other'] 
                },
                relation: { type: 'string', description: 'e.g., lives_in, allergic_to, works_at, likes, experienced' }
              },
              required: ['name', 'type', 'relation']
            }
          },
          reasoning: { type: 'string', description: 'Brief explanation for extraction, classification, and scoring' }
        },
        required: ['content', 'type', 'importance', 'emotional_weight', 'entities', 'reasoning']
      }
    }
  },
  required: ['memories']
};

const SYSTEM_PROMPT = `You are the Memory Extraction Subsystem of Engram, a cognitive architecture for AI agents.
Your task is to analyze the conversation turn and extract any meaningful, enduring facts, preferences, life events, or rules revealed by the user.

EXTRACT:
- Core personal facts: user's residence, job, family, pets, relationships, age, background.
- Health, medical & safety facts (HIGHEST IMPORTANCE): allergies, dietary restrictions, medical conditions, medications, phobias.
- Preferences & tastes: favorite foods, languages, tech stacks, hobbies, disfavored things.
- Life events & milestones: moving cities, career changes, marriage, births, bereavement, exams, promotions.
- Explicit requests: "Remember that...", "Keep in mind that...", "Never do X".
- Interaction rules (procedural): "I prefer concise answers", "Always write code in TypeScript".

SKIP:
- Casual chit-chat, greetings, filler ("hello", "thanks", "sounds good", "nice weather today").
- Ephemeral conversational context that will not matter tomorrow ("explain line 5", "run this command again").
- Information generated purely by the assistant (only extract truths about or stated by the user).
- Speculative questions without embedded facts ("What would happen if aliens landed?").

SCORING GUIDELINES:
Importance (0.0 - 1.0):
- 0.9 - 1.0: Critical safety/health (allergies, medical conditions) or explicit "remember this" directives.
- 0.7 - 0.8: Primary life facts (location, employer, primary relationship, profession).
- 0.5 - 0.6: Strong recurring preferences, ongoing major projects, specialized skills.
- 0.3 - 0.4: Casual preferences or minor episodic events.
- 0.0 - 0.2: Trivial background chatter (should rarely be stored).

Emotional Weight (0.0 - 1.0):
- 0.8 - 1.0: Deeply emotional, traumatic, or life-defining (illness, death, birth, layoff, marriage).
- 0.5 - 0.7: High personal meaning (relocation, job transition, long-term breakup).
- 0.2 - 0.4: Mild personal sentiment (proud of a project, annoyed by traffic, excited about a movie).
- 0.0 - 0.1: Neutral/factual details (e.g. "User is 32 years old").

Format all memory content as concise, standalone third-person assertions: e.g., "User is severely allergic to peanuts".`;

/**
 * Fast-path check for trivial inputs that definitely contain zero extractable memories.
 */
function isTrivialInput(text: string): boolean {
  const cleaned = text.trim().toLowerCase().replace(/[^\w\s]/g, '');
  const trivialPhrases = new Set([
    'ok', 'okay', 'yes', 'no', 'yep', 'nope', 'thanks', 'thank you',
    'thx', 'cool', 'great', 'awesome', 'bye', 'goodbye', 'hi', 'hello',
    'hey', 'good morning', 'good night', 'sounds good', 'sure', 'got it',
    'k', 'nice', 'sweet'
  ]);
  return trivialPhrases.has(cleaned);
}

/**
 * Extracts enduring memories, emotional weights, and entities from a conversation turn.
 */
export async function extractMemories(
  userMessage: string,
  assistantResponse: string,
  llm: LLMProvider,
  contextTurns: Message[] = []
): Promise<ExtractedMemory[]> {
  const sanitizedUser = userMessage.slice(0, 4000).trim();
  if (!sanitizedUser || isTrivialInput(sanitizedUser)) {
    return [];
  }

  const promptMessages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];

  // Provide recent context turns if available for grounding
  if (contextTurns.length > 0) {
    const recent = contextTurns.slice(-4);
    const contextText = recent
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');
    promptMessages.push({
      role: 'user',
      content: `Prior Conversation Context:\n${contextText}\n\nCurrent Turn to Analyze:\nUser: ${sanitizedUser}\nAssistant: ${assistantResponse}\n\nExtract all qualifying memories.`
    });
  } else {
    promptMessages.push({
      role: 'user',
      content: `Current Turn to Analyze:\nUser: ${sanitizedUser}\nAssistant: ${assistantResponse}\n\nExtract all qualifying memories.`
    });
  }

  try {
    const result = await llm.chatJSON<ExtractionResult>(promptMessages, EXTRACTION_SCHEMA, {
      temperature: 0.1
    });

    if (!result || !Array.isArray(result.memories)) {
      return [];
    }

    // Validate and normalize extracted memories
    return result.memories.map(mem => {
      const importance = typeof mem.importance === 'number' && !isNaN(mem.importance)
        ? Math.max(0.0, Math.min(1.0, mem.importance))
        : 0.5;

      const emotionalWeight = clampEmotionalWeight(mem.emotional_weight);

      const type = ['episodic', 'semantic', 'procedural'].includes(mem.type)
        ? mem.type
        : 'semantic';

      const entities = Array.isArray(mem.entities)
        ? mem.entities.map(e => ({
            name: String(e.name || '').trim(),
            type: (e.type || 'other') as EntityType,
            relation: String(e.relation || 'related_to').trim()
          })).filter(e => e.name.length > 0)
        : [];

      return {
        content: String(mem.content || '').trim(),
        type,
        importance,
        emotional_weight: emotionalWeight,
        entities,
        reasoning: String(mem.reasoning || '').trim()
      };
    }).filter(mem => mem.content.length > 0);
  } catch (error) {
    // Non-fatal: if extraction fails, log and proceed gracefully
    console.error('[Engram Extraction] Error extracting memories from turn:', error);
    return [];
  }
}
