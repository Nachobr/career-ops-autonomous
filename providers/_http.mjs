// HTTP transport helpers shared across providers.
// Files prefixed with _ are never loaded as providers by scan.mjs.

import { withRetry } from '../lib/retry.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; career-ops/1.3)';

function retryableHttp(err) {
  if (err?.status) return err.status === 429 || err.status >= 500;
  return /fetch failed|network|timeout|abort|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|429|5\d\d/i.test(String(err?.message || err || ''));
}

function retryLog(err, attempt, delayMs) {
  const msg = String(err?.message || err || 'error').split('\n')[0];
  console.warn(`  ↻ retry ${attempt} after ${delayMs}ms: ${msg}`);
}

async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null, redirect = 'follow' } = {}) {
  return await withRetry(async () => {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers },
      body,
      redirect,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      const snippet = responseText.replace(/\s+/g, ' ').trim().slice(0, 300);
      const err = new Error(snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`);
      err.status = res.status;
      err.body = responseText;
      throw err;
    }
    return res;
  }, {
    attempts: 3,
    retryOn: retryableHttp,
    onRetry: retryLog,
  });
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return await res.json();
}

export async function fetchText(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return await res.text();
}

export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson,
    fetchText,
  };
}
