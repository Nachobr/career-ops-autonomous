export const DEFAULT_RETRY = { attempts: 4, baseMs: 500, factor: 2, jitter: 0.25, maxMs: 30000 };

// Default extractor for a server-provided backoff hint (e.g. an HTTP
// `Retry-After` header parsed into err.retryAfterMs by a provider). When
// present and larger than the computed backoff, it wins — so we wait exactly as
// long as an overloaded endpoint (NVIDIA NIM, OpenAI, etc.) asks us to.
function retryAfterFromError(err) {
  const ms = err && typeof err === 'object' ? err.retryAfterMs : null;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);

    function done() {
      cleanup();
      resolve();
    }

    function abort() {
      cleanup();
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    }

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    }

    signal?.addEventListener?.('abort', abort, { once: true });
  });
}

function computeDelay(attempt, { baseMs, factor, jitter, maxMs }) {
  const raw = baseMs * Math.pow(factor, attempt - 1);
  const spread = raw * jitter;
  const randomized = raw + ((Math.random() * 2) - 1) * spread;
  const delay = Math.max(0, Math.round(randomized));
  return Number.isFinite(maxMs) && maxMs > 0 ? Math.min(delay, maxMs) : delay;
}

/**
 * withRetry(fn, opts) — run fn() with exponential backoff + jitter.
 */
export async function withRetry(fn, opts = {}) {
  const config = { ...DEFAULT_RETRY, ...opts };
  const attempts = Math.max(1, Math.floor(config.attempts || DEFAULT_RETRY.attempts));
  const retryOn = typeof config.retryOn === 'function' ? config.retryOn : () => true;
  const retryAfter = typeof config.retryAfter === 'function' ? config.retryAfter : retryAfterFromError;
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      let shouldRetry = false;
      try {
        shouldRetry = attempt < attempts && retryOn(err);
      } catch {
        shouldRetry = false;
      }

      if (!shouldRetry) {
        if (err && typeof err === 'object') err.attempts = attempt;
        throw err;
      }

      let delayMs = computeDelay(attempt, config);
      // Honor a server-provided Retry-After hint when it asks us to wait longer
      // than our computed backoff (still capped by maxMs to avoid absurd waits).
      const hinted = retryAfter(err);
      if (Number.isFinite(hinted) && hinted > delayMs) {
        delayMs = Number.isFinite(config.maxMs) && config.maxMs > 0 ? Math.min(hinted, config.maxMs) : hinted;
      }
      try {
        config.onRetry?.(err, attempt, delayMs);
      } catch {}
      await sleep(delayMs, config.signal);
    }
  }

  if (lastErr && typeof lastErr === 'object') lastErr.attempts = attempts;
  throw lastErr;
}
