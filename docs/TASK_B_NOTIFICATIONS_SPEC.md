# Task B — Notifications: Implementation Spec

**Source:** `docs/PRODUCTION_UNATTENDED_PLAN.md` §Task B (lines 141-203).
**Depends on:** Task A (Structured logging) — already merged. Use `lib/logger.mjs` as the reference for style, file layout, and test scaffolding.
**Out of scope:** Tasks C/D/E/F/G/H. Do not modify the review queue, browser assistant, retry, SQLite, or CI workflows beyond `test-all.mjs`.

---

## 1. Goal (one paragraph)

Add a single notifications module (`lib/notify.mjs`) that emits user-visible events from `commands/run.mjs` (and any future caller) through pluggable channels configured in `config/profile.yml`. The file channel is mandatory and always writes an audit line; webhook channels (Slack/Discord) and email are optional and best-effort. Missing optional secrets must warn, never crash. Secrets and sensitive answers must never appear in notification bodies.

---

## 2. Repo conventions to honor

- ES modules only (`.mjs`), Node ≥ 20, no TypeScript, no new heavyweight deps.
- New top-level helpers go in `lib/` (mirror `lib/logger.mjs` style: small surface, named exports, no global state).
- All user-facing config goes in `config/profile.yml` (user layer, never overwritten by updates). Update `config/profile.example.yml` for defaults.
- Env vars are documented in `.env.example`. Secrets are read from env, never from yaml.
- Every new CLI flag has `--help` text.
- Every new code path has a test in `test-all.mjs`. Tests must run offline (no real Slack/Discord/SMTP calls).
- Follow the data contract (`AGENTS.md` → §Data Contract): user-specific data goes in user-layer files; system code in `lib/`, `commands/`, root scripts.

---

## 3. Files to create

### 3.1 `lib/notify.mjs` (new)

Public API (named exports):

```js
export async function notify({ kind, title, body, severity = 'info', meta = {} })
export function loadNotificationConfig(profilePath?)   // returns parsed config or defaults
export const AUDIT_LOG_PATH                            // resolved absolute path
```

**`notify` contract:**
- `kind` (string, required): short stable identifier, e.g. `run_failed`, `review_enqueued`, `followups_due`, `run_completed`, `test`.
- `title` (string, required): one-line human summary, ≤ 120 chars.
- `body` (string, required): plain text or markdown, ≤ 2 KB. Truncate longer values and append `…(truncated)`.
- `severity`: one of `info | warn | error`. Default `info`.
- `meta`: free-form JSON-serializable object. Logged verbatim into the audit file. Caller is responsible for redaction.
- Always appends one NDJSON line to `data/logs/notifications.ndjson` with shape:
  ```json
  {"ts":"2026-...Z","runId":"...","kind":"...","severity":"...","title":"...","body":"...","meta":{...},"channels":[{"type":"file","ok":true},{"type":"slack","ok":false,"reason":"missing SLACK_WEBHOOK"}]}
  ```
- Reads `process.env.CAREER_OPS_RUN_ID` (set by `bin/career-ops.mjs`) for correlation.
- Returns `{ ok: boolean, channels: [...] }`. `ok` is `true` if file channel succeeded; outbound channel failures do NOT flip `ok` to false unless `required: true` is set on that channel.
- Never throws on outbound channel errors. Catches, logs to stderr (`console.warn`) with a short message, records `{ok:false, reason}` in the audit entry.

**`loadNotificationConfig`:**
- Reads `config/profile.yml` (path overrideable for tests).
- Returns `{ enabled: bool, channels: [...] }`.
- Defaults when `notifications` key is absent: `{ enabled: true, channels: [{ type: 'file', path: 'data/logs/notifications.ndjson', min_severity: 'info' }] }`.
- If `enabled: false`, `notify()` still writes the audit line but skips all outbound channels; record `skipped: true` in audit.

**Channels (implement in this order):**

1. **`file`** (required, always implicit even if not configured):
   - Resolves `path` relative to repo root.
   - `mkdirSync(dirname, { recursive: true })`.
   - Appends one NDJSON line.
   - Honors `min_severity`.

2. **`slack`** / **`discord`** (webhook):
   - Reads webhook URL from `process.env[channel.webhook_env]`. If missing → warn + record `{ok:false, reason:'missing <ENV>'}`. Do not crash.
   - Uses built-in `fetch` with 5s timeout (use `AbortSignal.timeout(5000)`).
   - Payload shape:
     - Slack: `{ text: \`*${severity.toUpperCase()}* — ${title}\n${body}\` }`
     - Discord: `{ content: \`**${severity.toUpperCase()}** — ${title}\n${body}\` }`
   - Treat any non-2xx response as failure; capture status code in `reason`.

3. **`desktop`** (optional, best-effort):
   - Use `node-notifier` ONLY if it is already a dependency. If not, register channel as `{ok:false, reason:'desktop channel not available'}` once and continue. Do not add the dep.

4. **`email`**:
   - Out of scope for this PR (write a stub channel returning `{ok:false, reason:'email channel not implemented'}` so the config shape is forward-compatible). Document this clearly in `docs/SCRIPTS.md`.

**Severity filtering:** order is `info < warn < error`. A channel with `min_severity: warn` skips `info` notifications (records `skipped_by_severity: true`).

**Body redaction helper (internal):**
```js
function redact(s) {
  // Replace common secret patterns BEFORE sending outbound.
  // - Bearer tokens, API keys (sk-..., ghp_..., ngrok URLs ending in ngrok-free.app paths with tokens)
  // - Email addresses inside body (replace local part: jane.doe@x.com → j***@x.com)
}
```
Apply `redact()` to `body` only for outbound channels; the file audit keeps the original (file is local-only).

---

## 4. Files to modify

### 4.1 `commands/run.mjs`

Add notifications at four hook points. Keep the existing `--no-notify` flag meaning ("suppress final summary text block") **distinct from** outbound notifications. Introduce a separate flag:

- `--no-alerts` → skip calling `notify()` entirely for this run (still writes the run log).

Hooks (call `notify` after the relevant action, never replace logger calls):

| Hook | When | kind | severity | title pattern | body |
|------|------|------|----------|---------------|------|
| Run failed | A required step fails (existing `aborted` branch) | `run_failed` | `error` | `career-ops run failed: <step>` | `Reason: <abortReason>\nrunId: <id>\nlog: <logger.file>` |
| Run completed with findings | After successful run, if `results` contains any new `review_enqueued` items OR newly-passed evals | `run_completed` | `info` | `career-ops run ok — <N> new high-fit, <M> follow-ups` | step summary table (text) |
| Review enqueued | After `auto-apply` or pipeline step produces new queue ids (use `beforeQueueIds` diff already in `run.mjs`) | `review_enqueued` | `info` | `<count> new high-fit job(s) queued for review` | bullet list of `q-xxxx company — role (score)` |
| Follow-ups due | After `followup` step succeeds, parse its stdout JSON for `due_count > 0` | `followups_due` | `info` | `<N> follow-up(s) due today` | first 5 lines of cadence output |

Implementation notes:
- Import once at top: `import { notify } from '../lib/notify.mjs';`
- Wrap every `await notify(...)` in `try/catch` and degrade to `logger.warn` — never let a notification failure abort the run.
- Skip all four hooks if `opts.noAlerts` is true.
- Dry-run: emit a single `kind: 'run_dryrun'` notification with severity `info` so users testing wiring see something.

Add to `printHelp()`:
```
--no-alerts              Skip outbound notifications (audit log still written).
```

### 4.2 `config/profile.example.yml`

Append (do not move existing keys):

```yaml
# Notifications for unattended runs (Task B).
# The file channel always writes data/logs/notifications.ndjson.
# Outbound channels are best-effort: missing secrets warn but never crash.
notifications:
  enabled: true
  channels:
    - type: file
      path: data/logs/notifications.ndjson
      min_severity: info
    # Uncomment and configure to enable:
    # - type: slack
    #   webhook_env: SLACK_WEBHOOK
    #   min_severity: warn
    # - type: discord
    #   webhook_env: DISCORD_WEBHOOK
    #   min_severity: error
```

### 4.3 `.env.example`

The `SMTP_PASS`, `SLACK_WEBHOOK`, `DISCORD_WEBHOOK` lines already exist. Update the surrounding comment from "future unattended mode" to "Task B notifications". No new env keys.

### 4.4 `docs/SCRIPTS.md`

Add a new section `## notifications` after the `## structured logs` section. Cover:
- What `lib/notify.mjs` does and which hooks call it from `commands/run.mjs`.
- The four `kind` values and when they fire.
- Severity filtering rules.
- How to enable Slack/Discord via `config/profile.yml` + env.
- Audit file location, line schema, never-throws guarantee, redaction policy.
- Status of `desktop` (optional dep) and `email` (stubbed, returns `not implemented`).
- The `--no-alerts` flag on `career-ops run`.

### 4.5 `test-all.mjs`

Add a new section `## 2E. Notifications (Task B)` right after the existing `## 2D. Schedule command` block. Follow the existing `pass()/fail()` pattern. All tests must be **offline and deterministic**.

Required tests:

1. **Syntax check:** `node --check lib/notify.mjs` passes.
2. **File channel writes valid NDJSON:**
   - Import `notify` dynamically.
   - Point audit log to a `mkdtempSync(...)` temp file via an env override (`CAREER_OPS_NOTIFY_AUDIT` — see §6).
   - Call `notify({ kind:'test', title:'t', body:'b', severity:'info' })`.
   - Read file, parse line, assert all required fields present and `runId` matches `process.env.CAREER_OPS_RUN_ID` if set.
3. **Severity filtering:** Configure a channel with `min_severity: warn`, send an `info` notification, assert audit line records `skipped_by_severity: true` for that channel and file channel still wrote.
4. **Disabled config:** With `enabled: false`, audit line still written, `channels` array empty or all marked `skipped: true`. Document which.
5. **Missing webhook env:** Configure a slack channel without setting `SLACK_WEBHOOK`. Assert no crash, audit line has `{type:'slack', ok:false, reason:/missing/}`.
6. **Mock webhook server:** Spin up a one-shot `http.createServer` on `127.0.0.1:0`, point a slack channel at `webhook_env: TEST_WEBHOOK`, set `process.env.TEST_WEBHOOK = url`, call `notify`. Assert server received exactly one POST with JSON body containing `text` field, and audit shows `ok:true`.
7. **Body redaction (outbound only):** Send body containing `sk-test1234567890ABCD` and an email. Mock webhook receives redacted body; file audit retains original.
8. **`commands/run.mjs` wiring smoke:** Run `node bin/career-ops.mjs run --dry-run --only=doctor`. Assert audit file gained at least one new line with `kind: 'run_dryrun'`.
9. **`--no-alerts` flag:** Run with `--no-alerts --dry-run --only=doctor`. Assert no new audit line.

Use the existing `run('node', [...])` helper. Clean up temp files in the test like the logger tests do.

---

## 5. Acceptance criteria (must all pass)

- `node test-all.mjs --quick` exits 0 with **no new failures** (warning count may rise by at most 0; pre-existing 14 warnings stay 14).
- `cat config/profile.example.yml | grep -A2 notifications:` shows the new block.
- `node bin/career-ops.mjs run --help` lists `--no-alerts`.
- After a real `career-ops run --dry-run`, `data/logs/notifications.ndjson` contains at least one valid JSON line.
- `grep -ri "SLACK_WEBHOOK\|SMTP_PASS" lib/ commands/` shows env reads only (never hardcoded values).
- A simulated required-step failure (e.g. `--only=doctor` with `STUB_DOCTOR_FAIL=1` if you add such hook, OR a unit test calling `notify({severity:'error',kind:'run_failed',...})` directly) produces an `error` audit entry.
- `node bin/career-ops.mjs run --dry-run --only=doctor` still prints `log: …ndjson` and exits 0.

---

## 6. Test hooks to add (small, internal)

To keep tests hermetic without monkey-patching:

- `lib/notify.mjs` resolves audit path in this order:
  1. `process.env.CAREER_OPS_NOTIFY_AUDIT` (test-only override)
  2. `config.channels[*]` with `type:'file'` first match
  3. Default: `data/logs/notifications.ndjson`
- `loadNotificationConfig(profilePath)` accepts an optional path so tests can pass a fixture without touching the real `config/profile.yml`.

Document both hooks in a short comment block at the top of `lib/notify.mjs`. Do not document `CAREER_OPS_NOTIFY_AUDIT` in user-facing docs.

---

## 7. Non-goals (explicit; do not do)

- No real SMTP/email implementation. Stub channel only.
- No new npm deps. (If you genuinely need one, stop and ask first.)
- No changes to `commands/review.mjs`, `commands/schedule.mjs`, `application-browser-assistant.mjs`, or `batch-pipeline.mjs`. (Schedule integration is a Task B follow-up; out of scope here.)
- No retry/backoff logic — that is Task E.
- No new CLI subcommand. `notify` is a library function used by `commands/run.mjs`. Do **not** add `career-ops notify` to `bin/career-ops.mjs`.
- No changes to the existing `--no-notify` semantic. `--no-notify` still controls the printed summary block; `--no-alerts` is the new outbound switch.

---

## 8. Suggested implementation order

1. Write `lib/notify.mjs` skeleton with file channel only. Verify by hand.
2. Add tests 1-4 (file channel, severity, disabled, runId).
3. Add slack/discord channel + tests 5-7 (mock webhook + redaction).
4. Wire into `commands/run.mjs` at the four hook points + `--no-alerts`.
5. Add tests 8-9 (run-wiring smoke + --no-alerts).
6. Update `config/profile.example.yml`, `.env.example` comment, `docs/SCRIPTS.md`.
7. Run `node test-all.mjs --quick`. Iterate until 0 failures.

---

## 9. Handoff prompt (paste this to the other LLM verbatim)

> Read `AGENTS.md`, `docs/PRODUCTION_UNATTENDED_PLAN.md` §Task B, and `docs/TASK_B_NOTIFICATIONS_SPEC.md`. Implement only Task B per the spec. Follow repo conventions: ES modules, Node ≥ 20, no TypeScript, no new npm deps, no user-specific data in system files. Add `lib/notify.mjs`, wire `commands/run.mjs` (four hook points + `--no-alerts`), update `config/profile.example.yml`, `.env.example` comment, `docs/SCRIPTS.md`, and add tests to `test-all.mjs`. Tests must be offline (mock webhook server, no real Slack/Discord/SMTP). Do not touch the review queue, browser assistant, scheduler, batch pipeline, or CI workflows. When done, run `node test-all.mjs --quick` and report files changed, validation output, and any blockers.
