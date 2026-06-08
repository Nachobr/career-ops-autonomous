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

  // Abort a hung request so an overloaded endpoint (e.g. NVIDIA NIM under load)
  // surfaces a retryable timeout instead of blocking the pipeline forever.
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS) || 180000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      const te = new Error(`OpenAI API request timed out after ${timeoutMs}ms`);
      te.code = 'ETIMEDOUT';
      te.retryable = true;
      throw te;
    }
    // Network-level failure (DNS, connection reset) — let the caller retry.
    if (e && typeof e === 'object') e.retryable = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`OpenAI API ${res.status}: ${txt.slice(0, 500)}`);
    err.status = res.status;
    // 429 (rate limit) and 5xx (overloaded/unavailable/gateway) are transient.
    err.retryable = [408, 409, 425, 429, 500, 502, 503, 504].includes(res.status);
    // Honor a Retry-After header (seconds or HTTP-date) when the server sends it.
    const ra = res.headers.get('retry-after');
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs)) {
        err.retryAfterMs = Math.max(0, secs * 1000);
      } else {
        const when = Date.parse(ra);
        if (!Number.isNaN(when)) err.retryAfterMs = Math.max(0, when - Date.now());
      }
    }
    throw err;
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const finishReason = data.choices?.[0]?.finish_reason ?? null;
  const usage = data.usage
    ? {
        input_tokens: data.usage.prompt_tokens,
        output_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
      }
    : null;

  return { text, usage, finishReason };
}
