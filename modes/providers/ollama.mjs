/**
 * modes/providers/ollama.mjs — Local Ollama adapter
 *
 * Talks to a local Ollama instance over its HTTP API. No API key required.
 *
 * Honors:
 *   OLLAMA_HOST (default: http://localhost:11434)
 *   OLLAMA_MODEL (default: qwen2.5:7b)
 */

export const NAME = 'ollama';
export const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

export function isConfigured() {
  // Ollama is always "configured" — at worst the HTTP call will fail at runtime
  // with a clear "ECONNREFUSED" message. We don't probe the daemon here because
  // isConfigured() is called frequently (e.g. by `login --status`).
  return true;
}

export async function complete({ system, user, model, maxTokens = 4096, temperature = 0.3 }) {
  const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
  const url = `${host}/api/chat`;

  const body = {
    model: model || DEFAULT_MODEL,
    stream: false,
    options: {
      temperature,
      num_predict: maxTokens,
    },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const err = new Error(`Could not reach Ollama at ${host}: ${e.message}`);
    err.cause = e;
    throw err;
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`Ollama API ${res.status}: ${txt.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data.message?.content ?? '';
  const usage = (data.prompt_eval_count != null || data.eval_count != null)
    ? {
        input_tokens: data.prompt_eval_count ?? null,
        output_tokens: data.eval_count ?? null,
        total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      }
    : null;

  return { text, usage };
}
