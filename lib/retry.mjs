export const DEFAULT_RETRY = { attempts: 4, baseMs: 500, factor: 2, jitter: 0.25 };

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

function computeDelay(attempt, { baseMs, factor, jitter }) {
  const raw = baseMs * Math.pow(factor, attempt - 1);
  const spread = raw * jitter;
  const randomized = raw + ((Math.random() * 2) - 1) * spread;
  return Math.max(0, Math.round(randomized));
}

/**
 * withRetry(fn, opts) — run fn() with exponential backoff + jitter.
 */
export async function withRetry(fn, opts = {}) {
  const config = { ...DEFAULT_RETRY, ...opts };
  const attempts = Math.max(1, Math.floor(config.attempts || DEFAULT_RETRY.attempts));
  const retryOn = typeof config.retryOn === 'function' ? config.retryOn : () => true;
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

      const delayMs = computeDelay(attempt, config);
      try {
        config.onRetry?.(err, attempt, delayMs);
      } catch {}
      await sleep(delayMs, config.signal);
    }
  }

  if (lastErr && typeof lastErr === 'object') lastErr.attempts = attempts;
  throw lastErr;
}
