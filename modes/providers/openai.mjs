/**
 * modes/providers/openai.mjs — OpenAI Chat Completions adapter
 *
 * Uses Chat Completions over fetch (Node 20+ has global fetch).
 * Avoids adding the `openai` npm SDK as a hard dependency.
 *
 * Honors:
 *   OPENAI_API_KEY  (required)
 *   OPENAI_BASE_URL (optional; defaults to https://api.openai.com/v1)
 */

export const NAME = 'openai';
export const DEFAULT_MODEL = 'gpt-4o-mini';

export function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function complete({ system, user, model, maxTokens = 4096, temperature = 0.3 }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const err = new Error('OPENAI_API_KEY is not set');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const url = `${base}/chat/completions`;

  const body = {
    model: model || DEFAULT_MODEL,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`OpenAI API ${res.status}: ${txt.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const usage = data.usage
    ? {
        input_tokens: data.usage.prompt_tokens,
        output_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
      }
    : null;

  return { text, usage };
}
