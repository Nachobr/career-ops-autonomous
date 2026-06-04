/**
 * liveness-browser.mjs — Playwright-backed job posting liveness probe
 *
 * Navigates to a job URL with a provided Playwright `page`, gathers the HTTP
 * status, final (post-redirect) URL, visible body text, and clickable control
 * labels, then defers the decision to the pure classifier in liveness-core.mjs.
 *
 * Zero LLM tokens — pure Playwright + heuristics.
 *
 * Contract (relied on by scan.mjs --verify/--recheck and check-liveness.mjs):
 *   checkUrlLiveness(page, url) -> { result, code, reason }
 *     result: 'active' | 'expired' | 'uncertain'
 *     code:   stable machine code (see below + liveness-core.mjs)
 *
 * Permanent up-front URL guard codes (treated as `uncertain` so the caller can
 * route them to scan-history without ever reaching pipeline.md):
 *   invalid_url | unsupported_protocol | blocked_host
 * Transient navigation failures (retry next scan):
 *   navigation_error
 */

import { classifyLiveness } from './liveness-core.mjs';

const NAV_TIMEOUT_MS = 30000;
const SETTLE_TIMEOUT_MS = 5000;

// Reject URLs that point at the local machine / private networks / cloud
// metadata endpoints — these should never be probed.
function isBlockedHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  if (h === '169.254.169.254') return true; // cloud metadata
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

// Returns a guard failure { code, reason } or null when the URL is acceptable.
function guardUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { code: 'invalid_url', reason: `malformed URL: ${rawUrl}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { code: 'unsupported_protocol', reason: `unsupported protocol: ${u.protocol}` };
  }
  if (isBlockedHost(u.hostname)) {
    return { code: 'blocked_host', reason: `blocked host: ${u.hostname}` };
  }
  return null;
}

export async function checkUrlLiveness(page, url) {
  const guard = guardUrl(url);
  if (guard) {
    return { result: 'uncertain', code: guard.code, reason: guard.reason };
  }

  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
  } catch (err) {
    // DNS failure, connection refused, timeout, etc. — transient; let the
    // caller keep the posting and retry on the next scan.
    return {
      result: 'uncertain',
      code: 'navigation_error',
      reason: `navigation failed: ${String(err.message || err).split('\n')[0]}`,
    };
  }

  const status = response ? response.status() : 0;
  const finalUrl = page.url();

  let bodyText = '';
  try {
    bodyText = await page.evaluate(() => document.body?.innerText || '');
  } catch {
    bodyText = '';
  }

  let applyControls = [];
  try {
    applyControls = await page.evaluate(() => {
      const els = [...document.querySelectorAll('a, button, input[type="submit"], [role="button"]')];
      return els
        .map((e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim())
        .filter(Boolean);
    });
  } catch {
    applyControls = [];
  }

  return classifyLiveness({ status, finalUrl, bodyText, applyControls });
}
