# Production Unattended Mode — Implementation Spec

Goal: make `career-ops` safe enough to run unattended for days via `career-ops schedule`, while preserving the core ethical rule: **the system may discover, evaluate, draft, notify, and fill applications, but it must never final-submit an application without the user**.

This plan assumes the autonomous CLI MVP already exists:

- `bin/career-ops.mjs`
- `commands/run.mjs`
- `commands/schedule.mjs`
- `commands/login.mjs`
- `modes/runner.mjs`
- `doctor.mjs --json`

The remaining work is the production-hardening slice from `docs/AUTONOMOUS_CLI_TODO.md`: review queue, notifications, structured logging, retry/dead-letter handling, tracker storage hardening, and broad tests/CI.

---

## Non-negotiable constraints

1. **No automatic final submission**
   - No code path may click a final submit/send/apply button.
   - Approval queues and browser assistants may prepare applications only.
   - The user must manually confirm submission before status changes to `Applied`.

2. **Respect the Data Contract**
   - User data stays in user-layer files: `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `portals.yml`, `data/*`, `reports/*`, `output/*`, `interview-prep/*`.
   - System behavior goes in system-layer files: scripts, modes except `_profile.md`, templates, dashboard, docs.
   - Never put user-specific targeting, salary, visa, personal details, or narrative in shared system files.

3. **Keep scripts standalone and CLI-routed**
   - Every new command must support `node <file>.mjs --help`.
   - Every new user-facing command must be exposed through `bin/career-ops.mjs`.
   - Add docs in `docs/SCRIPTS.md` and tests in `test-all.mjs`.

4. **No required network/API keys in tests**
   - Use stub providers, local fixtures, and deterministic sample files.
   - Tests must pass without real LLM keys, SMTP, Slack, Discord, or browser access unless explicitly marked optional.

5. **Small, reviewable increments**
   - Implement one task per branch/session.
   - Do not mix unrelated refactors with hardening work.

---

## Target unattended architecture

```diagram
╭──────────────╮
│ schedule     │  launchd/systemd/daemon
╰──────┬───────╯
       ▼
╭──────────────╮
│ run lock     │  data/.run.lock prevents overlap
╰──────┬───────╯
       ▼
╭──────────────╮
│ doctor gate  │  fail fast before writes
╰──────┬───────╯
       ▼
╭──────────────╮     ╭──────────────╮
│ scan/eval/pdf│────▶│ retry wrapper│
╰──────┬───────╯     ╰──────┬───────╯
       ▼                    ▼
╭──────────────╮     ╭──────────────╮
│ tracker DB   │     │ dead-letter  │
│ + markdown   │     │ queue        │
╰──────┬───────╯     ╰──────────────╯
       ▼
╭──────────────╮     ╭──────────────╮
│ review queue │────▶│ apply helper │  fills/drafts, never submits
╰──────┬───────╯     ╰──────────────╯
       ▼
╭──────────────╮
│ notify/log   │  file + optional desktop/email/slack/discord
╰──────────────╯
```

---

## Implementation order

Use this order. It reduces risk because each later task can consume the infrastructure from earlier tasks.

1. **Task A — Structured logging**
2. **Task B — Notifications**
3. **Task C — Submit-review queue**
4. **Task D — Browser application assistant guardrails**
5. **Task E — Retry, backoff, and dead-letter queue**
6. **Task F — SQLite tracker mirror**
7. **Task G — Production test/CI suite**
8. **Task H — Operator docs and runbook**

Minimum production-unattended acceptance: Tasks A, B, C, E, and G pass. Tasks D and F are strongly recommended before long-running automation, but D can be manual/draft-only at first and F can be deferred if run frequency is low.

---

## Task A — Structured logging

**Why:** unattended runs need machine-readable logs for debugging, schedule status, notification context, and postmortems.

### Deliverables

- Add `lib/logger.mjs` exporting:
  - `createLogger({ runId, file, cmd })`
  - methods: `info(msg, meta)`, `warn(msg, meta)`, `error(msg, meta)`, `event(name, meta)`
  - helper: `getDefaultLogPath(runIdOrDate)` if useful
- NDJSON line shape:
  ```json
  { "ts": "2026-05-28T12:00:00.000Z", "level": "info", "runId": "abc12345", "cmd": "run", "msg": "step started", "step": "scan" }
  ```
- `bin/career-ops.mjs` creates one `CAREER_OPS_RUN_ID` per invocation if absent and forwards it to child processes.
- `commands/run.mjs` writes one event per step:
  - `run_started`
  - `step_started`
  - `step_finished`
  - `step_failed`
  - `run_finished`
- Logs live under `data/logs/run-<ISO>-<runId>.ndjson`.
- Maintain `data/logs/latest.ndjson` as a symlink when supported; copy or small pointer file is acceptable on platforms where symlink fails.
- Rotation keeps the latest 50 `run-*.ndjson` files.

### Acceptance

- `career-ops run --dry-run` creates or updates a valid log file.
- Every log line parses as JSON.
- A forced failed step logs `level: "error"` and `event: "step_failed"`.
- `career-ops schedule status` can read latest log metadata: last run time, final status, step count, last error.

### Tests

- Unit test logger writes valid NDJSON.
- Rotation test with temporary directory keeps only 50 run logs.
- CLI smoke test verifies `CAREER_OPS_RUN_ID` is present in child environment or appears in logs.

### Handoff prompt

> Implement only Task A from `docs/PRODUCTION_UNATTENDED_PLAN.md`. Add `lib/logger.mjs`, wire `bin/career-ops.mjs`, `commands/run.mjs`, and `commands/schedule.mjs` minimally. Update `docs/SCRIPTS.md` and `test-all.mjs`. Do not implement notifications, retry, review queue, or SQLite. Run `node test-all.mjs`.

---

## Task B — Notifications

**Why:** unattended runs must tell the user when something important happened.

### Deliverables

- Add `lib/notify.mjs` exporting:
  ```js
  async function notify({ kind, title, body, severity = 'info', meta = {} })
  ```
- Always append audit events to `data/logs/notifications.ndjson` regardless of configured channels.
- Read optional notification config from `config/profile.yml`:
  ```yaml
  notifications:
    enabled: true
    channels:
      - type: file
        path: data/logs/notifications.ndjson
        min_severity: info
      - type: desktop
        min_severity: warn
      - type: email
        min_severity: error
        smtp:
          host: smtp.example.com
          port: 587
          user: user@example.com
          pass_env: SMTP_PASS
          from: user@example.com
          to: user@example.com
      - type: slack
        webhook_env: SLACK_WEBHOOK
      - type: discord
        webhook_env: DISCORD_WEBHOOK
  ```
- Implement channels in this order:
  1. file channel
  2. desktop channel if dependency already exists or can be optional
  3. webhook channels using built-in `fetch`
  4. email last; if adding dependency, keep it minimal and documented
- Wire `commands/run.mjs` triggers:
  - high-score offers/review queue entries: `success`
  - follow-ups due: `info`
  - failed required step: `error`
  - run completed with no findings: optional `info`, configurable/noise-controlled
- Never include secrets or full sensitive answers in notification bodies.

### Acceptance

- With only file channel configured, `career-ops run --dry-run` or a test notification writes NDJSON.
- Forced run failure writes an `error` notification.
- Missing optional webhook/email secrets produce a warning log, not a crash, unless that channel is explicitly required.

### Tests

- File-channel notification writes valid JSON.
- Severity filtering works.
- Disabled notifications still write the audit event or explicitly skip only outbound channels; document chosen behavior.
- Webhook tests use a local mock HTTP server, not Slack/Discord.

### Handoff prompt

> Implement only Task B from `docs/PRODUCTION_UNATTENDED_PLAN.md`. Add `lib/notify.mjs`, file-channel first, optional webhook support if small. Wire `commands/run.mjs` for success/error/follow-up notifications. Update examples in `config/profile.example.yml`, `.env.example`, `docs/SCRIPTS.md`, and `test-all.mjs`. No real external services in tests.

---

## Task C — Submit-review queue

**Why:** unattended evaluation can find good jobs, but application submission must remain user-approved.

### Deliverables

- Add or maintain `data/review-queue.md` on first use.
- Add `commands/review.mjs` exposed as `career-ops review`.
- Subcommands:
  - `career-ops review list [--json]`
  - `career-ops review show <id>`
  - `career-ops review enqueue --report <path> [--url <url>] [--pdf <path>]`
  - `career-ops review approve <id> [--browser]`
  - `career-ops review reject <id> [--reason "..."]`
- Queue entry fields:
  - `id`: stable short id, e.g. `q-<8charhash>` from normalized company + role + URL/report path
  - `date`
  - `company`
  - `role`
  - `score`
  - `status`: `Pending`, `Approved`, `Rejected`, `Submitted`, `Stale`
  - `url`
  - `report`
  - `pdf`
  - `notes`
- Add config defaults to `config/profile.example.yml`:
  ```yaml
  review:
    apply_threshold: 4.0
    enqueue_statuses: [Evaluated]
  ```
- Wire `commands/run.mjs` or `batch-pipeline.mjs` after report generation:
  - parse score from report/machine summary
  - if score >= threshold, enqueue idempotently
  - notify user of pending review item
- `reject` updates queue status and marks matching tracker row as `SKIP` with reason in notes.
- `approve` may launch application assistant, but must not mark `Applied` unless the user confirms submission after the assistant completes.

### Acceptance

- Re-running enqueue on same report does not duplicate queue entries.
- A 4.5/5 report is enqueued by `career-ops run`; a 3.5/5 report is not.
- `review reject` updates queue and tracker consistently.
- Nothing in `run`, `review`, or `apply` final-submits an application.

### Tests

- Queue parser/serializer round trip.
- Stable id generation.
- Threshold filtering.
- Reject updates tracker in a temp fixture.
- Approve dry-run/fixture verifies no submit action.

### Handoff prompt

> Implement only Task C from `docs/PRODUCTION_UNATTENDED_PLAN.md`. Add `commands/review.mjs`, expose it in `bin/career-ops.mjs`, wire high-score enqueue after evaluations, and add tests with markdown fixtures. Preserve the no-final-submit rule. Do not implement browser automation beyond invoking existing apply helper or a placeholder.

---

## Task D — Browser application assistant guardrails

**Why:** users want repetitive form filling automated, but final submission must be impossible from unattended code paths.

### Deliverables

- Extend `career-ops apply` with:
  - `career-ops apply <url|report|company> --browser`
  - `career-ops apply <url|report|company> --browser --dry-run`
  - `career-ops review approve <id> --browser`
- Visible Playwright by default: `headless: false`.
- Dry-run mode uses local HTML fixtures or fetched pages to detect fields but makes no changes.
- Field categories:
  - **Safe factual:** name, email, location, portfolio, LinkedIn, GitHub from `config/profile.yml`.
  - **Draftable:** cover-letter/free-text answers generated from CV/report and visibly filled.
  - **Sensitive/manual:** authorization, visa, salary, notice, relocation, demographics, disability, veteran, criminal history. Fill only if explicit policy exists in `config/profile.yml`; otherwise pause/report.
- Detect final submit controls by text/name/role patterns:
  - `submit`, `send application`, `apply now`, `complete application`, `enviar`, `postuler`, `bewerbung absenden`, etc.
- Never click final submit controls. Add a central helper such as `isFinalSubmitControl()` and route every click through a guard.
- Write audit artifact:
  - `output/applications/{reportNum}-{company}-{date}.md`
  - includes field labels, proposed answers, skipped fields, and manual decisions
  - excludes secrets and sensitive demographic values unless user explicitly configured them

### Acceptance

- Local fixture with final submit button proves the assistant never clicks it.
- Sensitive field with no profile value is skipped and reported.
- Non-empty user-edited fields are not overwritten without confirmation.
- At the end, terminal/browser message says: “Review the application in the browser. I will not submit it for you. Click submit manually if everything is correct.”

### Tests

- HTML fixture for a normal form.
- HTML fixture for multi-step form where `Next` is allowed but final `Submit` is blocked.
- HTML fixture with sensitive fields.
- Audit file content check.

### Handoff prompt

> Implement only Task D from `docs/PRODUCTION_UNATTENDED_PLAN.md`. Add safe browser form-fill support with Playwright fixtures. Centralize submit-button detection and prove with tests that final submit is never clicked. Do not add automatic submission or status `Applied` without explicit user confirmation.

---

## Task E — Retry, backoff, and dead-letter queue

**Why:** unattended runs must survive flaky portals, transient browser failures, and LLM/API outages without losing all progress.

### Deliverables

- Add `lib/retry.mjs` exporting:
  ```js
  async function withRetry(fn, { attempts = 3, baseMs = 500, factor = 2, jitter = true, retryOn } = {})
  ```
- Add `lib/dead-letter.mjs` or include helpers in `lib/retry.mjs`:
  - `appendDeadLetter({ source, url, payload, error, attempts, runId })`
  - writes to `data/dead-letter.ndjson`
- Dead-letter line shape:
  ```json
  { "ts": "...", "source": "pipeline.scrape", "url": "https://...", "error": "timeout", "attempts": 3, "runId": "abc12345" }
  ```
- Wrap likely transient operations:
  - portal HTTP calls in `scan.mjs`
  - JD scraping in `batch-pipeline.mjs`
  - LLM calls in `modes/runner.mjs`
  - Playwright page load/PDF generation in `generate-pdf.mjs`
- Add `commands/retry-dead-letter.mjs` exposed as:
  - `career-ops retry-dead-letter list`
  - `career-ops retry-dead-letter run [--source <name>] [--max N]`
  - `career-ops retry-dead-letter clear --older-than 30d`
- A failed item should not abort the whole batch unless it is a required global step like doctor/preflight.

### Acceptance

- A mocked operation failing twice then succeeding passes with retries.
- A permanently failing job URL writes one dead-letter entry and the rest of the batch continues.
- `retry-dead-letter run --max 1` reprocesses one queued failure or prints a clear unsupported-source message.

### Tests

- Unit tests for backoff without sleeping long; inject fake sleep.
- Dead-letter append parses as JSON.
- Batch fixture continues after one failed URL.

### Handoff prompt

> Implement only Task E from `docs/PRODUCTION_UNATTENDED_PLAN.md`. Add retry/dead-letter utilities, wrap transient operations, expose `career-ops retry-dead-letter`, and test with mocked failures. Do not change application scoring or submission behavior.

---

## Task F — SQLite tracker mirror

**Why:** markdown is good for users and agents, but weak for concurrent unattended writes.

### Deliverables

- Add dependency `better-sqlite3` if acceptable for the project; otherwise document and implement a file-lock fallback.
- Add `lib/tracker-db.mjs` with:
  - `openTrackerDb(path = 'data/tracker.sqlite')`
  - `migrate(db)`
  - `upsertApplication(app)`
  - `listApplications()`
  - `importApplicationsMarkdown(markdown)`
  - `exportApplicationsMarkdown(rows)`
- Schema:
  ```sql
  CREATE TABLE applications (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    company TEXT NOT NULL,
    role TEXT NOT NULL,
    score REAL,
    status TEXT NOT NULL,
    pdf INTEGER,
    report_path TEXT,
    url TEXT,
    notes TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(company, role)
  );
  CREATE TABLE follow_ups (
    id INTEGER PRIMARY KEY,
    application_id INTEGER,
    due_date TEXT,
    sent_at TEXT,
    notes TEXT
  );
  CREATE TABLE dead_letter (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    source TEXT NOT NULL,
    url TEXT,
    error TEXT,
    attempts INTEGER,
    payload_json TEXT
  );
  ```
- Add `commands/migrate-tracker.mjs`:
  - imports `data/applications.md` into DB idempotently
  - prints row count
- Extend `career-ops tracker export --format=md|csv|json`.
- Update `merge-tracker.mjs`:
  - write/update DB first
  - regenerate `data/applications.md` from DB
  - keep markdown output compatible with existing tools
- Preserve existing markdown as human-readable source during migration; only switch DB to source of truth after tests pass.

### Acceptance

- Migration row count equals markdown table row count.
- DB → markdown export passes `verify-pipeline.mjs`.
- Running migration twice does not duplicate rows.
- Simulated concurrent writes do not corrupt markdown or DB.

### Tests

- Markdown parse fixture.
- Import/export round trip.
- Duplicate company+role upsert.
- Concurrent merge simulation where possible.

### Handoff prompt

> Implement only Task F from `docs/PRODUCTION_UNATTENDED_PLAN.md`. Add tracker DB library, migration command, and markdown export. Keep existing markdown format compatible and idempotent. Run focused tests plus `node verify-pipeline.mjs`.

---

## Task G — Production test and CI suite

**Why:** unattended mode should fail in CI before it fails in a scheduled job.

### Deliverables

- Expand `test-all.mjs` to cover:
  - every `career-ops <subcommand> --help` exits 0
  - `career-ops run --dry-run` expected step order
  - logger NDJSON shape
  - notifications file channel
  - review queue idempotency and reject behavior
  - retry success/failure/dead-letter paths
  - tracker DB round trip, if Task F is implemented
  - browser assistant fixtures, if Task D is implemented
  - `modes/runner.mjs` with stub provider
- Add or update GitHub Actions workflow:
  - Node 20 and 22 matrix
  - `npm ci`
  - `node test-all.mjs`
  - no real secrets required
- Make failures grouped and easy to diagnose by task area.

### Acceptance

- `node test-all.mjs` passes locally without API keys.
- CI matrix is green on Node 20 and 22.
- Tests do not require live web pages or external LLM providers.

### Handoff prompt

> Implement only Task G from `docs/PRODUCTION_UNATTENDED_PLAN.md`. Expand tests for completed unattended components and add/adjust CI. Use local fixtures and stub providers only. Do not implement new product features while writing tests.

---

## Task H — Operator docs and runbook

**Why:** unattended systems need clear setup, monitoring, failure handling, and rollback instructions.

### Deliverables

- Add `docs/UNATTENDED.md` covering:
  - prerequisites
  - `career-ops doctor`
  - `career-ops login --status`
  - `career-ops run --dry-run`
  - `career-ops schedule install --every 3d --max-jobs 3`
  - `career-ops schedule status`
  - review queue workflow
  - notification setup
  - dead-letter retry workflow
  - rollback/update guidance
  - safety boundaries: no final submit
- Update `README.md` quick start with a short unattended section linking to the full doc.
- Update `docs/SCRIPTS.md` for every new command.
- Update `AGENTS.md`/`CLAUDE.md` main-file tables if new files are added.

### Acceptance

- A new user can follow docs from fresh checkout to scheduled dry-run.
- Docs explicitly state that applications are never submitted automatically.
- All referenced commands exist and `--help` works.

### Handoff prompt

> Implement only Task H from `docs/PRODUCTION_UNATTENDED_PLAN.md`. Write operator-facing docs for unattended operation and update command references. Verify every command in the docs exists. Do not change runtime behavior except fixing obvious doc-command mismatches.

---

## Global acceptance for production unattended

Before calling this complete, run:

```bash
node test-all.mjs
career-ops doctor --json
career-ops run --dry-run
career-ops schedule status
career-ops review list
career-ops login --status
```

Then perform one controlled live-ish run with a small cap:

```bash
career-ops run --max-jobs 1
```

Expected outcome:

- no overlapping run allowed
- logs created under `data/logs/`
- notification audit event written
- transient failures retried or dead-lettered
- high-score job added to review queue
- tracker remains valid after merge/normalize/dedup/verify
- no application is submitted automatically

---

## Suggested meta-prompt for the cheaper implementation agent

Use this exact prompt for each isolated session:

> Read `AGENTS.md`, `docs/AUTONOMOUS_CLI_TODO.md`, and `docs/PRODUCTION_UNATTENDED_PLAN.md`. Implement only **Task X** from `docs/PRODUCTION_UNATTENDED_PLAN.md`. Follow repo conventions: ES modules, Node >= 20, no TypeScript, no user-specific data in system files, every new command has `--help`, update `docs/SCRIPTS.md`, add focused tests to `test-all.mjs`, and run the narrowest relevant validation. Do not implement other tasks. Report files changed, validation output, and any blockers.

---

## Risk notes for implementers

- `data/*`, `reports/*`, and `output/*` are user-layer. Treat live files carefully; tests should use temp directories or fixtures.
- Do not edit `modes/_profile.md` unless the user explicitly asks for personalization.
- Do not mark a tracker row `Applied` just because a browser assistant opened or filled a form.
- If adding dependencies, keep them minimal and update `package.json` plus any docs/tests.
- Prefer append-only audit logs for unattended actions.
- Prefer fail-open for job discovery uncertainty only when it avoids losing a real offer; prefer fail-closed for application submission and sensitive fields.
