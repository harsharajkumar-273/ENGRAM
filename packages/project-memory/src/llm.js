// Claude access via a direct Anthropic REST call, not the SDK — keeps the
// prototype dependency-free. Used for (a) real memory-candidate extraction
// once ANTHROPIC_API_KEY is configured (see memory/extract.js and the
// "Swapping in real LLM extraction" section of the README) and (b) generating
// a final cited answer in the `ask` CLI command.
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';

export function llmAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function complete({ system, messages, maxTokens = 1024 }) {
  if (!llmAvailable()) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data.content ?? []).map((block) => block.text ?? '').join('\n');
}
