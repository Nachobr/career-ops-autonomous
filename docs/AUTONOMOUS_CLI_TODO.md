# Autonomous CLI — Implementation TODO

Goal: turn career-ops into a fully autonomous system driven by a **single CLI binary** (`career-ops`), without requiring a human-in-the-loop AI coding CLI (Claude Code / OpenCode / Gemini CLI) for the day-to-day pipeline.

This file is the **execution spec**. Each task is self-contained so it can be implemented by a cheaper LLM in a separate session. Tasks are ordered by dependency. Items marked **MVP** are the minimum to claim "autonomous from a single CLI". Items marked **HARDENING** are needed before leaving it running unattended for days.

Conventions for the implementer LLM:
- All scripts are ES modules (`.mjs`), Node ≥ 20, no TypeScript.
- Keep style consistent with existing files in repo root (`scan.mjs`, `batch-pipeline.mjs`, `merge-tracker.mjs`).
- Never write user-specific data into system-layer files (see `CLAUDE.md` → Data Contract).
- Every new script must be invocable standalone (`node <file>.mjs --help`) AND from the new `career-ops` dispatcher.
- Add a brief entry to `docs/SCRIPTS.md` for every new script.
- Add unit-ish checks to `test-all.mjs` for every new subcommand (at minimum: `--help` exits 0).

---

## Compact implementation plans

Use this section as the short planning index before expanding any individual task.

### Task 1 — `bin/career-ops` unified entrypoint

- Create `bin/career-ops.mjs` with a small dispatcher table mapping subcommands to existing scripts.
- Add `"bin": { "career-ops": "bin/career-ops.mjs" }` to `package.json`.
- Implement `--help`, `help <cmd>`, `--version`, aliases, and exit-code propagation from child processes.
- Keep existing npm scripts unchanged; only route CLI calls to current scripts.
- Add tests for `career-ops --help`, `--version`, and one representative subcommand.

### Task 2 — Headless mode runner

- Add `modes/runner.mjs` with `runMode({ mode, inputs, provider })`.
- Load `_shared.md`, `_profile.md`, target mode file, CV, and config into a composed prompt.
- Add provider adapters under `modes/providers/` for Gemini, Anthropic, OpenAI, Ollama, and stub.
- Implement report auto-numbering, summary parsing, and optional `--out` writing.
- Add stub-provider tests so no real API key is needed.

### Task 3 — `career-ops run`

- Add `commands/run.mjs` orchestrating doctor → scan → pipeline → merge → normalize → dedup → verify → followup.
- Support `--dry-run`, `--only`, `--skip`, `--max-jobs`, `--engine`, and LLM override flags.
- Ensure each step logs status, duration, exit code, and failure reason.
- Write a per-run log to `data/logs/run-<ISO>.json`.
- Add tests for dry-run plan order and max-job/env forwarding.

### Task 4 — `career-ops schedule`

- Add `commands/schedule.mjs` with `install`, `status`, `uninstall`, and `daemon`.
- Generate macOS launchd plist or Linux systemd user timer based on platform.
- Implement cadence parsing: `30m`, `12h`, `3d`, `1w`.
- Add lock-file handling at `data/.run.lock` to prevent overlapping runs.
- Add tests for cadence parsing and generated unit/plist content.

### Task 5 — Submit-review queue

- Add/maintain `data/review-queue.md` with stable queue IDs.
- Add `commands/review.mjs` for `list`, `show`, `approve`, `reject`, and `enqueue`.
- Have pipeline enqueue offers scoring above `review.apply_threshold`.
- Ensure `reject` marks tracker rows as `SKIP`; `approve` launches the application assistant but does not submit.
- Add tests for idempotent enqueue, threshold filtering, and tracker status updates.

### Task 5B — Browser application assistant

- Add `--browser` mode to `career-ops apply` or create `application-browser-assistant.mjs`.
- Use visible Playwright to open the application URL, detect fields, fill safe fields, and stop before final submit.
- Implement strict field policy: pause for legal/sensitive/salary/visa fields unless configured.
- Write an audit draft to `output/applications/{report}-{company}-{date}.md`.
- Add local HTML fixture tests proving the submit button is never clicked.

### Task 6 — Notifications

- Add `lib/notify.mjs` with a provider-neutral `notify({ kind, title, body, severity })`.
- Implement file logging first; desktop/email/slack/discord as optional channels.
- Configure channels through `config/profile.yml`.
- Trigger notifications from `career-ops run` for high-score offers, failures, and follow-ups.
- Add tests using file channel only.

### Task 7 — Provider config & `career-ops login`

- Extend `config/profile.example.yml` with `llm.provider`, `model`, `temperature`, `max_tokens`, and fallback.
- Extend `.env.example` with provider keys and notification secrets.
- Add `commands/login.mjs` for `--provider`, `--status`, and `--force`.
- Validate keys with a minimal ping where possible, never printing secrets.
- Update `doctor.mjs` to warn when the configured provider lacks credentials.

### Task 8 — Structured logging

- Add `lib/logger.mjs` with `info`, `warn`, `error`, and `event`.
- Generate one `CAREER_OPS_RUN_ID` per CLI invocation.
- Write NDJSON logs to `data/logs/run-<ISO>.json` and maintain `latest.json`.
- Gradually wire scripts to logger when `CAREER_OPS_RUN_ID` exists.
- Add tests that validate log JSON shape and rotation behavior.

### Task 9 — Retry, backoff, dead-letter queue

- Add `lib/retry.mjs` implementing exponential backoff with jitter.
- Wrap scraping, LLM calls, portal HTTP calls, and PDF generation.
- Write exhausted failures to `data/dead-letter.ndjson`.
- Add `career-ops retry-dead-letter` to reprocess failed URLs.
- Add tests with mocked failures that succeed on retry and fail into dead-letter.

### Task 10 — SQLite tracker mirror — DONE

- Add `lib/tracker-db.mjs` using `better-sqlite3`.
- Define schema for applications, follow-ups, and dead-letter entries.
- Add migration command to import `data/applications.md`.
- Update `merge-tracker.mjs` to write DB first, then regenerate markdown.
- Add round-trip tests: markdown → DB → markdown with stable row count.

### Task 11 — `doctor.mjs` preflight gate

- Add `--json` output with structured check results.
- Check Node version, Playwright, required files, configured LLM, tracker validity, stale locks, and disk space.
- Make `career-ops run` call doctor early and abort on failed required checks.
- Keep human-readable output as default.
- Add tests for missing-file failure and valid JSON output.

### Task 12 — Tests & CI

- Expand `test-all.mjs` to cover every CLI subcommand’s `--help`.
- Add dry-run tests for `run`, stub tests for `runner`, and queue tests for `review`.
- Mock all network/LLM behavior; no real keys required.
- Add GitHub Actions matrix for Node 20 and 22.
- Make test output clear enough to diagnose failed task areas quickly.

### Cross-cutting documentation

- Update README with `career-ops run`, `career-ops apply --browser`, and safety boundaries.
- Add `docs/AUTONOMOUS.md` covering install, login, run, schedule, review, and apply.
- Update `docs/SCRIPTS.md` for every new script/command.
- Keep `CLAUDE.md` / `AGENTS.md` main-file tables current.
- Document that automation can fill and draft, but never final-submit applications.

---

## Task 1 — `bin/career-ops` unified entrypoint (MVP)

**Why:** Today users run 19 separate `.mjs` files + a bash runner. We need one command.

**Deliverables:**
- New file `bin/career-ops.mjs` with shebang `#!/usr/bin/env node`, `chmod +x`.
- New `bin` field in `package.json`:
  ```json
  "bin": { "career-ops": "bin/career-ops.mjs" }
  ```
- Subcommand dispatcher (no heavy framework — use a small hand-rolled parser or `node:util` `parseArgs`):
  - `career-ops scan` → spawn `scan.mjs`
  - `career-ops pipeline` → spawn `batch-pipeline.mjs`
  - `career-ops eval <url|file>` → spawn `local-eval.mjs` (or `gemini-eval.mjs` depending on `config/profile.yml.llm.provider`)
  - `career-ops pdf [report]` → spawn `generate-pdf.mjs`
  - `career-ops latex [report]` → spawn `generate-latex.mjs`
  - `career-ops tracker` → print summary of `data/applications.md` (counts by status)
  - `career-ops followup` → spawn `followup-cadence.mjs`
  - `career-ops liveness` → spawn `check-liveness.mjs`
  - `career-ops merge` → spawn `merge-tracker.mjs`
  - `career-ops verify` → spawn `verify-pipeline.mjs`
  - `career-ops normalize` → spawn `normalize-statuses.mjs`
  - `career-ops dedup` → spawn `dedup-tracker.mjs`
  - `career-ops doctor` → spawn `doctor.mjs`
  - `career-ops update [check|apply|rollback]` → spawn `update-system.mjs`
  - `career-ops patterns` → spawn `analyze-patterns.mjs`
  - `career-ops apply <url>` → spawn `apply-assistant.mjs`
  - `career-ops run` → see Task 3
  - `career-ops schedule` → see Task 4
  - `career-ops help [cmd]` / `career-ops --help` / `-h`
  - `career-ops --version` (read from `VERSION` file)

**Acceptance:**
- `npx career-ops --help` lists every subcommand with a one-line description.
- `npx career-ops scan` produces identical output to `node scan.mjs`.
- All existing `npm run *` scripts in `package.json` continue to work unchanged.
- Exit code of the subcommand is propagated.

**Out of scope:** rewriting any existing script.

---

## Task 2 — Headless mode runner (`modes/runner.mjs`) (MVP)

**Why:** Most "modes" in `modes/*.md` are agent prompts that today require an interactive AI CLI to interpret them. For autonomy we need to execute a mode directly via an LLM API.

**Deliverables:**
- New file `modes/runner.mjs` exporting `async function runMode({ mode, inputs, provider })`.
- Loads `modes/_shared.md` + `modes/_profile.md` + `modes/<mode>.md` and concatenates as the system prompt.
- Substitutes simple `{{var}}` placeholders from `inputs` (e.g. `{{jd}}`, `{{cv}}`, `{{company}}`).
- Provider abstraction with adapters in `modes/providers/`:
  - `anthropic.mjs` (uses `@anthropic-ai/sdk`, env `ANTHROPIC_API_KEY`)
  - `openai.mjs` (uses `openai`, env `OPENAI_API_KEY`)
  - `gemini.mjs` (reuse `@google/generative-ai` from `gemini-eval.mjs`, env `GEMINI_API_KEY`)
  - `ollama.mjs` (HTTP `http://localhost:11434`, no key)
  - Each exports `async function complete({ system, user, model, maxTokens, temperature })` returning `{ text, usage }`.
- Provider + model chosen from `config/profile.yml` under new key `llm:` (see Task 7), fallback `gemini`.
- CLI usage: `node modes/runner.mjs --mode oferta --jd ./jds/x.txt --cv ./cv.md --out reports/NNN-x.md`.
- Auto-numbers reports per `CLAUDE.md` rule (`max(existing) + 1`, 3-digit zero-pad).

**Acceptance:**
- `node modes/runner.mjs --mode oferta --jd examples/sample-jd.txt --cv examples/sample-cv.md` produces a report file with Blocks A–F + G in `reports/` without any human typing.
- Errors are printed to stderr and exit code ≠ 0 on failure.

**Out of scope:** replacing `batch/batch-runner.sh` — that's Task 3.

---

## Task 3 — `career-ops run` end-to-end command (MVP)

**Why:** The glue. One command that does scan → evaluate → PDF → tracker → verify.

**Deliverables:**
- New file `commands/run.mjs` invoked by `bin/career-ops.mjs run`.
- Pipeline:
  1. `doctor.mjs` (fail-fast preflight)
  2. `scan.mjs` (refresh inbox in `data/pipeline.md`)
  3. `check-liveness.mjs` (drop dead URLs)
  4. `batch-pipeline.mjs` — but switched to use `modes/runner.mjs` instead of `claude -p` (replace the `execSync` invocation; gate behind `--engine=runner|claude`, default `runner`).
  5. For each new report → `generate-pdf.mjs`
  6. `merge-tracker.mjs`
  7. `normalize-statuses.mjs`
  8. `dedup-tracker.mjs`
  9. `verify-pipeline.mjs`
  10. `followup-cadence.mjs --json` → produce due-today list
  11. Call notifier (Task 6) with summary
- Flags:
  - `--dry-run` (skip writes, print plan)
  - `--only=scan,eval,pdf` (run subset)
  - `--max-jobs N` (cap pipeline evals)
  - `--engine=runner|claude` (whether to use Task 2 runner or shell out to `claude -p`)
- Single per-run log file at `data/logs/run-<ISO>.json` (Task 8).

**Acceptance:**
- `career-ops run --dry-run` prints the ordered step list and exits 0.
- `career-ops run --max-jobs 1` end-to-end produces ≥1 new report, ≥1 PDF, updates `data/applications.md`, and `verify-pipeline.mjs` reports clean.

---

## Task 4 — `career-ops schedule` (MVP)

**Why:** Autonomy means "set it and forget it." Need scheduling without external tools.

**Deliverables:**
- New file `commands/schedule.mjs`.
- Subcommands:
  - `career-ops schedule install --every 3d` — installs a launchd plist on macOS (`~/Library/LaunchAgents/io.santifer.career-ops.plist`) or a systemd user unit on Linux (`~/.config/systemd/user/career-ops.{service,timer}`) that runs `career-ops run` at the cadence.
  - `career-ops schedule status` — prints next-run, last-run, last-exit-code.
  - `career-ops schedule uninstall`.
  - `career-ops schedule daemon` — long-running foreground mode using `setInterval`, useful for Docker / tmux.
- Lock file at `data/.run.lock` (PID + start time); refuse to start if lock present and PID alive. Stale-lock detection (process gone) auto-clears.
- Cadence parser: `3d`, `12h`, `30m`, `1w`.
- Windows: print a `schtasks` command to copy-paste (no auto-install).

**Acceptance:**
- After `career-ops schedule install --every 3d`, `launchctl list | grep career-ops` (macOS) shows the agent.
- `career-ops schedule status` reads `data/logs/run-*.json` and prints last result.
- `career-ops schedule uninstall` cleanly removes the plist/unit.

---

## Task 5 — Submit-review queue (HARDENING)

**Why:** `CLAUDE.md` forbids auto-submitting applications. For unattended runs we need an approval queue.

**Deliverables:**
- New file `data/review-queue.md` (created on first use; gitignored — already covered by `data/*` ignore).
- New `commands/review.mjs`:
  - `career-ops review list` — table of pending items with score, company, role, JD URL, suggested CV PDF path.
  - `career-ops review approve <id>` — moves the item to "Approved", launches `apply-assistant.mjs` for that URL.
  - `career-ops review reject <id> [--reason "..."]` — marks status `SKIP` in `data/applications.md`.
  - `career-ops review show <id>` — prints the full report.
- `batch-pipeline.mjs` (or its new wrapper) enqueues items scoring ≥ `apply_threshold` (from `config/profile.yml`, default 4.0/5) into the queue. **It never submits.**
- Each queue entry has a stable short id (e.g. `q-<8charhash>`).

**Acceptance:**
- A run that produces a 4.5/5 evaluation adds an entry to the queue.
- `career-ops review approve q-xxxxxxxx` invokes `apply-assistant.mjs` with the right URL and updates status to `Applied` only after the assistant returns success.
- Nothing in the autonomous loop ever calls "submit" without going through the queue.

---

## Task 5B — Browser application assistant: auto-fill, stop before submit (HARDENING)

**Why:** `career-ops apply` currently drafts answers for copy/paste. Users want the CLI to do the repetitive browser work too: open the application URL, identify fields, fill safe answers, upload the generated CV when available, and stop at the final review/submit step. This preserves the hard rule that the user makes the final submission decision.

**Non-negotiable guardrail:** This task must **not** implement fully automatic submission. The assistant may click navigation buttons such as "Next" only when needed to reveal later form steps, but it must stop before any final action whose intent is submission (examples: `Submit`, `Send application`, `Apply now`, `Complete application`, `Enviar`, `Postuler`, `Bewerbung absenden`). The user must review and click the final submit action manually.

**Deliverables:**
- Extend `apply-assistant.mjs` or add a new script `application-browser-assistant.mjs` exposed as:
  - `career-ops apply <url|report|company> --file questions.txt` → current draft-only behavior remains supported.
  - `career-ops apply <url|report|company> --browser` → launches a visible Playwright browser, fills the application form, and stops before final submit.
  - Optional: `career-ops apply <url|report|company> --browser --dry-run` → prints detected fields and proposed values without typing into the page.
- Visible Playwright mode by default (`headless: false`) so the user can watch and intervene.
- Form-field detection for common ATS patterns:
  - Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Workday best-effort.
  - Text inputs, textareas, selects, radio buttons, checkboxes, file uploads.
  - Multi-step forms with safe `Next`/`Continue` navigation, but no final submission.
- Context loading:
  - Match by URL/report/company exactly as current `apply-assistant.mjs` does.
  - Use `cv.md`, `config/profile.yml`, `modes/_profile.md`, the evaluation report, and generated PDF path if available.
  - Generate missing answers via the configured LLM provider.
- Field policy:
  - Fill low-risk factual fields from `config/profile.yml` (name, email, location, LinkedIn/GitHub/portfolio if present).
  - Draft free-text answers from the report + CV and visibly fill them.
  - Never invent sensitive/legal answers. For work authorization, visa, disability, veteran status, demographic, criminal history, salary, notice period, or relocation questions: either use explicit values from `config/profile.yml` or pause and ask the user.
  - For salary/comp fields, prefer a configurable policy in `config/profile.yml`; if missing, pause instead of guessing.
  - Never overwrite a non-empty user-edited field without confirmation.
- Stop condition:
  - Detect final submit buttons and stop with a clear terminal + browser message: "Review the application in the browser. I will not submit it for you. Click submit manually if everything is correct."
  - After the user confirms they submitted, update tracker status to `Applied` and mark the review queue entry `approved`/`submitted` as appropriate.
- Audit output:
  - Write a local draft artifact to `output/applications/{reportNum}-{company}-{date}.md` containing field labels, proposed answers, skipped fields, and any user-required decisions.
  - Do not store secrets or sensitive demographic answers unless the user explicitly configured them in `config/profile.yml`.

**Acceptance:**
- `career-ops apply 657 --browser --dry-run` opens no browser or makes no page changes, and prints detected/proposed fields when a saved HTML fixture is provided in tests.
- `career-ops apply 657 --browser` opens a visible browser, fills a test fixture form, uploads a dummy/generated PDF when configured, and stops before the final submit button.
- Tests include at least one local HTML fixture with a final submit button and assert the code never clicks it.
- If a form contains a sensitive/legal field with no explicit profile answer, the assistant pauses and reports the required user decision instead of guessing.
- `career-ops review approve <id> --browser` can pass the queued URL/report into the browser assistant.
- Documentation makes the distinction explicit: `apply` can draft or fill forms, but it never submits applications.

---

## Task 6 — Notifications (HARDENING)

**Why:** No outbound channel today. Autonomous = "tell me when something interesting happened."

**Deliverables:**
- New file `lib/notify.mjs` exporting `async function notify({ kind, title, body, severity })`.
- Pluggable channels controlled by `config/profile.yml`:
  ```yaml
  notifications:
    enabled: true
    channels:
      - type: desktop        # node-notifier (optional dep)
      - type: email
        smtp: { host, port, user, pass_env: SMTP_PASS, from, to }
      - type: slack
        webhook_env: SLACK_WEBHOOK
      - type: discord
        webhook_env: DISCORD_WEBHOOK
      - type: file
        path: data/logs/notifications.ndjson
  ```
- Severity levels: `info`, `success`, `warn`, `error`. Each channel can filter via `min_severity`.
- Triggers (called from `commands/run.mjs`):
  - New offers scoring ≥ threshold → `success`
  - Follow-ups due today → `info`
  - Pipeline failure / verify error → `error`
- Always also writes to `data/logs/notifications.ndjson` regardless of channels (audit trail).

**Acceptance:**
- With `channels: [{ type: file, ... }]`, a `career-ops run` produces newline-delimited JSON events in the log.
- A forced error (e.g. break `data/applications.md` syntax) triggers a `severity: error` notification.

---

## Task 7 — Provider config & `career-ops login` (MVP)

**Why:** Today only `GEMINI_API_KEY` is documented. Autonomy needs multi-provider config + a sane place to store keys.

**Deliverables:**
- Extend `config/profile.example.yml` with:
  ```yaml
  llm:
    provider: gemini          # anthropic | openai | gemini | ollama
    model: gemini-2.0-flash
    max_tokens: 4096
    temperature: 0.3
    fallback: ollama          # used on rate-limit / outage
  ```
- Extend `.env.example` with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SMTP_PASS`, `SLACK_WEBHOOK`, `DISCORD_WEBHOOK`.
- New `commands/login.mjs`:
  - `career-ops login --provider anthropic` — prompts (TTY) for the key, validates it with a 1-token ping, writes to `.env` (creates it if absent, never overwrites existing keys without `--force`).
  - `career-ops login --status` — prints which providers are configured (✅/❌), never prints the secret.
- `doctor.mjs` extended: warns if `llm.provider` has no key set.

**Acceptance:**
- Fresh checkout → `cp config/profile.example.yml config/profile.yml` → `career-ops login --provider gemini` → `career-ops eval https://...` works.
- `career-ops login --status` shows correct provider availability without leaking secrets.

---

## Task 8 — Structured logging (HARDENING)

**Why:** Cron/launchd runs need machine-readable logs for debugging and `schedule status`.

**Deliverables:**
- New file `lib/logger.mjs` exporting `createLogger({ runId, file })` with methods `info/warn/error/event`.
- Each log line is JSON: `{ ts, level, runId, cmd, msg, ...meta }`.
- Per-run file at `data/logs/run-<ISO>.json` (ndjson). Symlink `data/logs/latest.json` → most recent.
- Rotation: keep last 50 runs, delete older.
- `bin/career-ops.mjs` generates the `runId` (uuid-ish, 8 chars) once per invocation and exports `CAREER_OPS_RUN_ID` so child scripts can reuse it.
- Existing scripts opt-in by reading `process.env.CAREER_OPS_RUN_ID` and logging via the logger if present (else fall back to existing `console.log`).

**Acceptance:**
- `career-ops run` produces one ndjson file in `data/logs/` with at least one event per pipeline step.
- `career-ops schedule status` (Task 4) parses the latest file and shows the last-exit-code + step count.

---

## Task 9 — Retry, backoff, dead-letter queue (HARDENING) — DONE

**Why:** Scraping and LLM calls fail intermittently. An autonomous loop must not abort the whole batch on one flaky URL.

**Deliverables:**
- New file `lib/retry.mjs` exporting `withRetry(fn, { attempts, baseMs, factor, jitter, retryOn })` (exponential backoff with jitter).
- Apply in:
  - `batch-pipeline.mjs` → JD scraping
  - `modes/runner.mjs` → LLM call
  - `generate-pdf.mjs` → Playwright page load
  - `scan.mjs` → portal HTTP calls
- Failed-after-retry items are written to `data/dead-letter.ndjson` with: `{ ts, source, url, error, attempts }`.
- New `career-ops retry-dead-letter` subcommand re-processes them.

**Acceptance:**
- Simulating a 500 on first scrape attempt then 200 on second → pipeline succeeds.
- A URL that always fails ends up in `data/dead-letter.ndjson` and does not abort the rest of the batch.

---

## Task 10 — SQLite mirror of the tracker (HARDENING) — DONE

**Why:** Markdown is great for AI/humans, fragile for scripts. Concurrent writers (scan + cron + manual edits) can corrupt the table.

**Deliverables:**
- New file `lib/tracker-db.mjs` using `better-sqlite3` (new dep).
- Schema:
  ```sql
  CREATE TABLE applications (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    company TEXT NOT NULL,
    role TEXT NOT NULL,
    score REAL,
    status TEXT NOT NULL,
    pdf INTEGER,         -- 0/1
    report_path TEXT,
    url TEXT,
    notes TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(company, role)
  );
  CREATE TABLE follow_ups (...);
  CREATE TABLE dead_letter (...);
  ```
- `merge-tracker.mjs` writes to SQLite first, then **regenerates** `data/applications.md` from the DB (DB is source of truth).
- New `career-ops tracker export --format=md|csv|json` reads from DB.
- Migration script `commands/migrate-tracker.mjs` that parses the existing `data/applications.md` into the DB (idempotent).

**Acceptance:**
- Running migration on the current tracker produces a DB with the same row count as the markdown table.
- Editing the DB and running `career-ops tracker export --format=md` reproduces a valid `data/applications.md`.
- Two concurrent `career-ops run` invocations (simulate with `&`) do not corrupt either the DB or the markdown.

---

## Task 11 — `doctor.mjs` becomes the preflight gate (HARDENING)

**Why:** `career-ops run` should fail fast with actionable errors, not 5 minutes in.

**Deliverables:**
- Extend `doctor.mjs` with new checks:
  - `node --version` ≥ 20
  - Playwright Chromium installed
  - `cv.md`, `config/profile.yml`, `modes/_profile.md`, `portals.yml` present (already partial)
  - LLM provider key for the configured `llm.provider`
  - `data/applications.md` parses cleanly (call `verify-pipeline.mjs` in `--quick` mode)
  - No stale lock file (`data/.run.lock` with dead PID)
  - Disk space ≥ 500MB free
- Add `--json` flag returning `{ ok: bool, checks: [{ name, ok, message }] }`.
- `commands/run.mjs` calls `doctor.mjs --json` and aborts on any failed check with `severity: error` notification (Task 6).

**Acceptance:**
- `career-ops doctor --json` prints valid JSON.
- Deleting `cv.md` makes `career-ops run` abort in <2s with a clear error.

---

## Task 12 — Tests & CI (HARDENING) — DONE

**Why:** Don't break the autonomous loop on refactor.

**Deliverables:**
- Extend `test-all.mjs`:
  - `career-ops --help` exits 0
  - Each subcommand `--help` exits 0
  - `commands/run.mjs --dry-run` prints expected step order
  - `lib/retry.mjs` unit (mocked fn fails twice succeeds third)
  - `lib/tracker-db.mjs` round-trip MD → DB → MD
  - `modes/runner.mjs` with stub provider returns deterministic output
- Add to `.github/workflows/` a job that runs `test-all.mjs` on Node 20 + 22.
- Ensure no test requires network or real LLM keys (use a `stub` provider in `modes/providers/stub.mjs`).

**Acceptance:**
- `node test-all.mjs` passes locally without any API key set.
- CI is green on the PR that adds Tasks 1–11.

---

## Cross-cutting documentation updates (do as part of each task)

- Update [README.md](../README.md) "Quick Start" → show `npm i -g . && career-ops run`.
- Update [docs/SETUP.md](SETUP.md) → autonomous mode section.
- Update [docs/SCRIPTS.md](SCRIPTS.md) → entry per new script.
- Update [CLAUDE.md](../CLAUDE.md) "Main Files" table with new files.
- Add `docs/AUTONOMOUS.md` explaining: install → login → schedule → review. — DONE

---

## Dependency graph

```diagram
╭────────╮   ╭────────╮   ╭───────╮
│ Task 1 │──▶│ Task 3 │──▶│Task 4 │
│  bin   │   │  run   │   │sched. │
╰───┬────╯   ╰───┬────╯   ╰───────╯
    │            │
    ▼            ▼
╭────────╮   ╭────────╮   ╭────────╮
│ Task 2 │   │ Task 7 │   │ Task 11│
│ runner │   │ login  │   │ doctor │
╰────────╯   ╰────────╯   ╰────────╯

       (HARDENING — can land after MVP)
╭────────╮ ╭────────╮ ╭────────╮ ╭────────╮ ╭────────╮
│ Task 5 │ │ Task 6 │ │ Task 8 │ │ Task 9 │ │Task 10 │ ─▶ Task 12 (tests)
│ review │ │ notify │ │  logs  │ │ retry  │ │ sqlite │
╰────────╯ ╰────────╯ ╰────────╯ ╰────────╯ ╰────────╯
```

**MVP slice** (smallest autonomous CLI): Tasks **1, 2, 3, 4, 7, 11**.
**Production-ready unattended:** add Tasks **5, 6, 8, 9, 10, 12**.

---

## Suggested per-task prompt for the cheaper LLM

> "Read `docs/AUTONOMOUS_CLI_TODO.md`, implement only **Task N**. Follow repo conventions in `CLAUDE.md` (Data Contract, ES modules, no TypeScript). Do not modify any other task's scope. When done, run `node test-all.mjs` and report the diff."
