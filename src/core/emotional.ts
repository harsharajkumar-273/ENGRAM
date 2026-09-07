// ============================================
// Engram Emotional Weight Scoring & Rubrics
// ============================================

/**
 * Emotional weight rubric reference:
 * 
 * 0.0 - 0.1: Completely neutral / mundane facts
 *   Examples: "Had coffee this morning", "Weather is sunny", "Read an article"
 * 
 * 0.2 - 0.4: Mild interest, casual preferences, or minor daily events
 *   Examples: "Thinking about learning Rust", "Liked the Italian restaurant downtown", "Commute was a bit slow"
 * 
 * 0.5 - 0.7: Significant personal relevance, life shifts, relationships, or career moves
 *   Examples: "Starting a new job next Monday", "Broke up with my partner of 3 years", "Moving to Lisbon"
 * 
 * 0.8 - 1.0: Deeply emotional, traumatic, or life-defining milestones
 *   Examples: "Diagnosed with Type 1 diabetes", "We are having our first baby", "Got unexpectedly laid off today"
 */

export interface EmotionalClassification {
  intensity: 'neutral' | 'mild' | 'significant' | 'critical';
  weight: number;
  decayMultiplier: number;
  description: string;
}

/**
 * Validates and clamps an emotional weight between 0.0 and 1.0.
 */
export function clampEmotionalWeight(weight: number): number {
  if (typeof weight !== 'number' || isNaN(weight)) return 0.0;
  return Math.max(0.0, Math.min(1.0, weight));
}

/**
 * Computes the emotional decay multiplier.
 * In Engram, emotional multiplier = 1 + E (range: 1.0 to 2.0).
 * Highly emotional memories decay up to 2x slower, mirroring human amygdala-hippocampus interaction.
 */
export function getEmotionalDecayMultiplier(emotionalWeight: number): number {
  const clamped = clampEmotionalWeight(emotionalWeight);
  return 1 + clamped;
}

/**
 * Categorizes an emotional weight into human-readable buckets.
 */
export function classifyEmotionalWeight(weight: number): EmotionalClassification {
  const clamped = clampEmotionalWeight(weight);
  
  if (clamped < 0.2) {
    return {
      intensity: 'neutral',
      weight: clamped,
      decayMultiplier: 1 + clamped,
      description: 'Mundane or factual statement with negligible emotional charge',
    };
  } else if (clamped < 0.5) {
    return {
      intensity: 'mild',
      weight: clamped,
      decayMultiplier: 1 + clamped,
      description: 'Casual preference or routine event with mild personal interest',
    };
  } else if (clamped < 0.8) {
    return {
      intensity: 'significant',
      weight: clamped,
      decayMultiplier: 1 + clamped,
      description: 'Important personal milestone, relationship change, or career shift',
    };
  } else {
    return {
      intensity: 'critical',
      weight: clamped,
      decayMultiplier: 1 + clamped,
      description: 'Deeply emotional, life-altering, or health/safety critical event',
    };
  }
}
