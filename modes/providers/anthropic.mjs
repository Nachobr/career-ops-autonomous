/**
 * modes/providers/anthropic.mjs — Anthropic Claude adapter
 *
 * Uses the Messages API over fetch (Node 20+ has global fetch).
 * Avoids adding @anthropic-ai/sdk as a hard dependency.
 *
 * Requires env ANTHROPIC_API_KEY.
 */

export const NAME = 'anthropic';
export const DEFAULT_MODEL = 'claude-3-5-sonnet-latest';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function complete({ system, user, model, maxTokens = 4096, temperature = 0.3 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const err = new Error('ANTHROPIC_API_KEY is not set');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: 'user', content: user }],
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`Anthropic API ${res.status}: ${txt.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = Array.isArray(data.content)
    ? data.content.filter(b => b.type === 'text').map(b => b.text).join('')
    : '';
  const usage = data.usage
    ? {
        input_tokens: data.usage.input_tokens,
        output_tokens: data.usage.output_tokens,
        total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
      }
    : null;

  return { text, usage };
}
