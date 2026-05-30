# Task 9 — Retry, Backoff & Dead-Letter Queue — Execution Spec

> Self-contained spec for one implementer LLM. Implement **only Task 9**. Do not
> touch other tasks' scope. When done, run `node test-all.mjs` and report the diff.

## Context & goal

`career-ops` is an autonomous job-application pipeline (ES modules, Node ≥ 20, **no
TypeScript**). Scraping and LLM calls fail intermittently (rate limits, Cloudflare,
network blips). Today a single flaky URL can abort a whole batch.

Goal: add a reusable retry helper with exponential backoff + jitter, wrap the four
unreliable I/O points with it, send permanently-failed items to a **dead-letter
queue** file, and add a `career-ops retry-dead-letter` subcommand to reprocess them.

## Conventions you MUST follow

- ES modules (`.mjs`), Node ≥ 20, no TypeScript, no new heavy deps.
- Match the style of existing `lib/*.mjs` (see `lib/logger.mjs`, `lib/notify.mjs`).
  - Root is resolved via `resolve(dirname(new URL('../package.json', import.meta.url).pathname))`.
- Never write user-specific data into system-layer files (see `CLAUDE.md` → Data Contract).
- `.gitignore` lists data files **individually** (there is no broad `data/*` rule).
  Add a new line `data/dead-letter.ndjson` to `.gitignore` alongside the other
  `data/...` entries.
- Every new script is standalone-invocable (`node <file>.mjs --help` exits 0) AND
  routed through `bin/career-ops.mjs`.
- Add a `docs/SCRIPTS.md` entry for the new command.
- Add checks to `test-all.mjs` (see Acceptance/Tests below).

---

## Deliverable 1 — `lib/retry.mjs`

New file exporting `withRetry`.

```js
// lib/retry.mjs
/**
 * withRetry(fn, opts) — run fn() with exponential backoff + jitter.
 *
 *   const result = await withRetry(() => fetch(url), {
 *     attempts: 4,          // total tries (default 4)
 *     baseMs: 500,          // first backoff delay (default 500)
 *     factor: 2,            // exponential multiplier (default 2)
 *     jitter: 0.25,         // ±25% randomization on each delay (default 0.25)
 *     retryOn: (err) => true,   // predicate: should this error be retried? (default: always)
 *     onRetry: (err, attempt, delayMs) => {}, // optional hook for logging
 *     signal,               // optional AbortSignal to cancel waits
 *   });
 */
export async function withRetry(fn, opts = {}) { ... }
```

Requirements:
- Calls `fn()` (which may be sync or async). On success returns its resolved value.
- On throw: if `attempt < attempts` AND `retryOn(err)` is true, wait
  `delay = baseMs * factor^(attempt-1)` adjusted by `±jitter` fraction, then retry.
- If `retryOn(err)` returns false, rethrow immediately (no more attempts).
- After the final attempt fails, rethrow the last error. Attach `err.attempts`
  (number of tries made) to the rethrown error object before throwing.
- `onRetry(err, attempt, delayMs)` is invoked before each wait (best-effort, wrap
  in try/catch so a bad hook never breaks retry).
- Respect `signal`: if aborted during a wait, reject promptly with the abort reason.
- Delay must never be negative; clamp jittered delay to `>= 0`.
- Pure helper — no logging side effects beyond the `onRetry` hook, no file writes.

Also export a small default config object for reuse:

```js
export const DEFAULT_RETRY = { attempts: 4, baseMs: 500, factor: 2, jitter: 0.25 };
```

---

## Deliverable 2 — `lib/dead-letter.mjs`

New file for the dead-letter queue (DLQ). Separate from `retry.mjs` so retry stays pure.

```js
// lib/dead-letter.mjs
export const DEAD_LETTER_PATH;  // absolute path to data/dead-letter.ndjson

// Append one failed item. Creates the file/dir if missing.
export function recordDeadLetter({ source, url, error, attempts, meta = {} }) { ... }

// Read all entries (returns []). Each line is JSON.
export function readDeadLetter() { ... }

// Overwrite the file with the given entries (used after reprocessing).
export function writeDeadLetter(entries) { ... }
```

Entry shape (one JSON object per line, NDJSON):

```json
{ "ts": "2025-05-29T10:00:00.000Z", "source": "scrape", "url": "https://...", "error": "HTTP 503", "attempts": 4, "runId": "ab12cd34", "meta": {} }
```

Requirements:
- `recordDeadLetter` adds `ts` (ISO now) and `runId` (from `process.env.CAREER_OPS_RUN_ID || null`) automatically.
- `source` is a short tag: one of `scrape`, `llm`, `pdf`, `scan`.
- `error` is a short single-line string (truncate to ~300 chars, take first line only).
- All writes use `appendFileSync` / `writeFileSync` with `mkdirSync(..., { recursive: true })` first.
- `readDeadLetter` tolerates blank lines and malformed lines (skip them, don't throw).

---

## Deliverable 3 — Wire `withRetry` into the four I/O points

Wrap each call so transient failures retry, and permanent failures go to the DLQ
(where a caller-level catch already exists). **Keep existing behavior**: these
functions still return `null` / skip on final failure — they must NOT start
throwing and aborting the batch. The only added behavior is (a) retrying and (b)
recording a dead-letter entry on final failure.

### 3a. `batch-pipeline.mjs` — JD scraping

- Import `withRetry` and `recordDeadLetter`.
- In `fetchJsonWithTimeout(url)` (line ~304): wrap the `fetch` in `withRetry` with
  `retryOn` = retry on network errors and HTTP 5xx / 429 (not 4xx other than 429).
  Keep the existing `{ ok, status }` / `{ ok, error }` return contract.
- In `scrapeJD(browser, url, companyHint)` (line ~380): wrap the
  `page.goto(...)` + content-extraction block in `withRetry`. On the final failure
  (the existing `catch (err)` that logs `❌ Failed to scrape` and returns `null`),
  also call `recordDeadLetter({ source: 'scrape', url, error: err.message, attempts: err.attempts ?? 1 })`.
- Use `DEFAULT_RETRY` but `attempts: 3` for browser scraping (Chromium retries are expensive).

### 3b. `modes/runner.mjs` — LLM call

- In `runMode(...)`, the provider call is `await prov.complete({...})` (line ~315).
- Wrap it with `withRetry`, `attempts: 4`, `retryOn` = retry on rate-limit / 5xx /
  network errors but NOT on auth errors (4xx auth). Heuristic: retry when the error
  message matches `/rate|timeout|ECONN|ETIMEDOUT|5\d\d|overloaded|429/i`.
- `runMode` currently throws on failure (it's called per-job inside a try/catch in
  `batch-pipeline.mjs`'s `evaluateWithRunner`). Keep it throwing after retries are
  exhausted; the DLQ recording happens at the batch level where the per-job
  `catch` already exists. In that batch-level catch, add
  `recordDeadLetter({ source: 'llm', url: job.url, error, attempts })`.
  (Find the existing per-job try/catch around `evaluateWithRunner` and add the DLQ
  write there — do not invent a new control path.)

### 3c. `generate-pdf.mjs` — Playwright page load

- Wrap `page.setContent(html, {...})` (line ~141) in `withRetry` (`attempts: 2`).
- On final failure, call `recordDeadLetter({ source: 'pdf', url: null, error: err.message, attempts, meta: { cv: 'cv.md' } })`
  before the existing top-level `.catch` exits. Preserve the current non-zero exit
  on failure — PDF generation is a single-shot CLI, so failing the process is fine,
  but still record the DLQ entry first.

### 3d. `scan.mjs` — portal HTTP calls

- All portal HTTP traffic funnels through `providers/_http.mjs`, which has a single
  `fetchWithTimeout(url, opts)` helper (line ~7) used by `fetchJson` and `fetchText`,
  which are exposed via `makeHttpCtx()`. **Wrap the `fetch` call inside
  `fetchWithTimeout` with `withRetry`** (`attempts: 3`, retry on 5xx / 429 / network
  errors, not on other 4xx) so every provider benefits from one change.
- On final per-provider failure, the existing `scan.mjs` provider loop already
  catches errors per company (see the `try { const jobs = await provider.fetch(...) }`
  around line ~416). In that catch, add
  `recordDeadLetter({ source: 'scan', url: entry, error: err.message, attempts: err.attempts ?? 1 })`.

### Logging hook (optional but preferred)

Where a logger is available (scripts that read `process.env.CAREER_OPS_RUN_ID`),
pass `onRetry: (err, attempt, delayMs) => console.warn(\`  ↻ retry ${attempt} after ${delayMs}ms: ${err.message.split('\n')[0]}\`)`.
Keep it to `console.warn` if no logger is wired — do not add new logger plumbing.

---

## Deliverable 4 — `commands/retry-dead-letter.mjs` + CLI wiring

New internal command, same shape as other `commands/*.mjs` (default export `async function (argv)` returning an exit code; see `commands/run.mjs` line ~460 for the pattern).

Behavior:
- `career-ops retry-dead-letter` — reads `data/dead-letter.ndjson`, and for each entry
  re-runs the appropriate operation based on `source`:
  - `scrape` / `scan` → re-queue the `url` into `data/pipeline.md` (append as an
    unchecked `- [ ] <url>` line if not already present) so the next `pipeline`/`run`
    picks it up. Do NOT re-scrape inline here.
  - `llm` → same: re-queue the `url` into `data/pipeline.md`.
  - `pdf` → print a notice that the user should re-run `career-ops pdf` (cannot be
    auto-requeued without the report context).
- Entries successfully re-queued are **removed** from the DLQ (rewrite the file with
  the remainder via `writeDeadLetter`). Entries that can't be requeued stay.
- Flags:
  - `--list` — print the DLQ contents as a table and exit (no changes).
  - `--clear` — empty the DLQ file (with a confirmation line) and exit.
  - `--dry-run` — print what would be requeued without modifying any file.
  - `--help` / `-h` — usage, exit 0.
- Print a summary: `N requeued, M skipped, K remaining`.

CLI wiring in `bin/career-ops.mjs`:
- Add to the `COMMANDS` table (near `review`/`run`, around line 67-73):
  ```js
  'retry-dead-letter': { internal: 'retry-dead-letter', desc: 'Reprocess failed items from the dead-letter queue (--list | --clear | --dry-run).' },
  ```
- Add a convenience alias in `ALIASES` (optional): `dlq: 'retry-dead-letter'`.
- The dispatcher's `runInternal(name)` maps `name` → `commands/<name>.mjs`
  (line ~299), so `retry-dead-letter` resolves to `commands/retry-dead-letter.mjs`
  automatically. Verify this — `runInternal` builds `${name}.mjs`, so the file name
  must be exactly `commands/retry-dead-letter.mjs`.

---

## Deliverable 5 — Docs

- Add a `docs/SCRIPTS.md` entry for `lib/retry.mjs`, `lib/dead-letter.mjs`, and the
  `retry-dead-letter` command (follow the existing table/section format there).
- Mark Task 9 progress in `docs/AUTONOMOUS_CLI_TODO.md` if a status convention exists
  (otherwise leave the TODO untouched).

---

## Deliverable 6 — Tests (`test-all.mjs`)

Add to `test-all.mjs` (mock all failures; **no network, no real keys**):

1. **Syntax**: `node --check lib/retry.mjs`, `lib/dead-letter.mjs`,
   `commands/retry-dead-letter.mjs` all pass (the existing syntax loop over root
   `*.mjs` won't cover `lib/`/`commands/`, so add explicit `--check` lines like the
   existing `lib/notify.mjs` checks at line ~324).
2. **Retry success-after-failures**: import `withRetry`, give it a counter fn that
   throws twice then returns `"ok"` with `baseMs: 1` — assert it resolves to `"ok"`
   and was called 3 times.
3. **Retry exhaustion**: a fn that always throws with `attempts: 2, baseMs: 1` —
   assert it rejects and the thrown error has `.attempts === 2`.
4. **retryOn=false short-circuits**: fn throws an "auth" error, `retryOn` returns
   false — assert called exactly once.
5. **Dead-letter round-trip**: set `CAREER_OPS_RUN_ID=test`, point the DLQ at a temp
   file (allow override via env var, e.g. `CAREER_OPS_DEAD_LETTER` — implement this
   override in `lib/dead-letter.mjs` mirroring how `lib/notify.mjs` supports
   `CAREER_OPS_NOTIFY_AUDIT`). Call `recordDeadLetter` twice, then `readDeadLetter`
   and assert 2 entries with correct `source`/`url` and an ISO `ts`.
6. **CLI help**: `career-ops retry-dead-letter --help` exits 0 (use the existing
   help-exit-0 test harness pattern).

Add the `CAREER_OPS_DEAD_LETTER` env override to `lib/dead-letter.mjs` so tests can
isolate the file (do NOT write into the real `data/dead-letter.ndjson` during tests).

---

## Acceptance criteria

- `node test-all.mjs` passes with no API keys and no network.
- A scrape that returns HTTP 503 on attempt 1 then 200 on attempt 2 succeeds (the
  whole batch does not abort).
- A URL that always fails ends up as one line in `data/dead-letter.ndjson` and the
  rest of the batch continues.
- `career-ops retry-dead-letter --list` prints the queued failures.
- `career-ops retry-dead-letter` re-queues `scrape`/`scan`/`llm` URLs into
  `data/pipeline.md` and removes them from the DLQ.
- `career-ops retry-dead-letter --help` exits 0 and is listed in `career-ops --help`.

## Out of scope

- SQLite (that's Task 10).
- Changing the notification system (Task 6) — you may optionally fire a
  `notify({ kind:'dead-letter', severity:'warn', ... })` when items are recorded, but
  it is not required.
- Rewriting provider logic or evaluation prompts.

## Files to create / modify (summary)

| Action | Path |
|--------|------|
| create | `lib/retry.mjs` |
| create | `lib/dead-letter.mjs` |
| create | `commands/retry-dead-letter.mjs` |
| modify | `batch-pipeline.mjs` (wrap `fetchJsonWithTimeout`, `scrapeJD`; DLQ on fail) |
| modify | `modes/runner.mjs` (wrap `prov.complete`) |
| modify | `batch-pipeline.mjs` per-job catch around `evaluateWithRunner` (DLQ `llm`) |
| modify | `generate-pdf.mjs` (wrap `page.setContent`; DLQ on fail) |
| modify | `scan.mjs` and/or `providers/_http.mjs` (wrap fetch; DLQ on fail) |
| modify | `bin/career-ops.mjs` (`COMMANDS` + optional alias) |
| modify | `test-all.mjs` (tests above) |
| modify | `docs/SCRIPTS.md` (entries) |

## Suggested implementation order

1. `lib/retry.mjs` + its 3 unit tests → get green.
2. `lib/dead-letter.mjs` + round-trip test (with `CAREER_OPS_DEAD_LETTER` override).
3. `commands/retry-dead-letter.mjs` + CLI wiring + `--help` test.
4. Wire the four I/O sites (3a–3d), one at a time, re-running `node test-all.mjs`.
5. Docs.
