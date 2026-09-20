import * as fs from 'node:fs';

export interface LongMemEvalInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: 'user' | 'assistant'; content: string; has_answer?: boolean }>>;
  answer_session_ids: string[];
}

export interface LongMemEvalCompatibilityReport {
  instances: number;
  questionTypes: Record<string, number>;
  sessions: number;
  evidenceSessions: number;
  malformedInstances: number;
}

/**
 * Validates the official LongMemEval schema without claiming answer accuracy.
 * The oracle file contains only evidence sessions and is therefore a compatibility
 * fixture, not a retrieval benchmark.
 */
export function inspectLongMemEval(path: string): LongMemEvalCompatibilityReport {
  const data = JSON.parse(fs.readFileSync(path, 'utf8')) as LongMemEvalInstance[];
  const report: LongMemEvalCompatibilityReport = {
    instances: data.length,
    questionTypes: {},
    sessions: 0,
    evidenceSessions: 0,
    malformedInstances: 0,
  };
  for (const instance of data) {
    const valid = typeof instance.question_id === 'string' &&
      typeof instance.question === 'string' &&
      Array.isArray(instance.haystack_sessions) &&
      Array.isArray(instance.haystack_session_ids) &&
      Array.isArray(instance.answer_session_ids) &&
      instance.haystack_sessions.length === instance.haystack_session_ids.length;
    if (!valid) report.malformedInstances++;
    report.questionTypes[instance.question_type] =
      (report.questionTypes[instance.question_type] || 0) + 1;
    report.sessions += instance.haystack_sessions.length;
    report.evidenceSessions += instance.answer_session_ids.length;
  }
  return report;
}
