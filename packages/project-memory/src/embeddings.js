// Embeddings via a direct OpenAI REST call (Anthropic has no embeddings
// endpoint), rather than pulling in an SDK. If OPENAI_API_KEY isn't set,
// embed() degrades gracefully to nulls and retrieval falls back to
// keyword-only (pg_trgm) search — see retrieval.js.
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

export function embeddingsAvailable() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function embed(texts) {
  if (!embeddingsAvailable() || texts.length === 0) {
    return texts.map(() => null);
  }
  const res = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI embeddings request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}
