# Scripts Reference

All scripts live in the project root as `.mjs` modules and are exposed via `npm run <name>`.

## Quick Reference

| Command | Script | Purpose |
|---------|--------|---------|
| `npm run cli -- <cmd>` | `bin/career-ops.mjs` | Unified CLI dispatcher |
| `npm run run:pipeline` | `bin/career-ops.mjs run` | End-to-end autonomous pipeline |
| `career-ops schedule ...` | `commands/schedule.mjs` | Recurring autonomous runs |
| `career-ops login ...` | `commands/login.mjs` | Configure LLM provider credentials |
| `npm run doctor` | `doctor.mjs` | Validate setup prerequisites |
| `npm run verify` | `verify-pipeline.mjs` | Check pipeline data integrity |
| `npm run normalize` | `normalize-statuses.mjs` | Fix non-canonical statuses |
| `npm run dedup` | `dedup-tracker.mjs` | Remove duplicate tracker entries |
| `npm run merge` | `merge-tracker.mjs` | Merge batch TSVs into applications.md |
| `npm run pdf` | `generate-pdf.mjs` | Convert HTML to ATS-optimized PDF |
| `npm run sync-check` | `cv-sync-check.mjs` | Validate CV/profile consistency |
| `npm run update:check` | `update-system.mjs check` | Check for upstream updates |
| `npm run update` | `update-system.mjs apply` | Apply upstream update |
| `npm run rollback` | `update-system.mjs rollback` | Rollback last update |
| `npm run liveness` | `check-liveness.mjs` | Test if job URLs are still active |
| `npm run scan` | `scan.mjs` | Zero-token portal scanner |

---

## career-ops CLI

Unified command dispatcher for all career-ops scripts. Installed via the `bin` field in `package.json` as `career-ops`, or run locally with `npm run cli -- <command>` / `node bin/career-ops.mjs <command>`.

```bash
career-ops --help
career-ops --version
career-ops help scan
career-ops doctor
career-ops scan
career-ops eval --file ./jds/role.txt
career-ops tracker
career-ops run --dry-run
```

The dispatcher forwards arguments to the underlying script and propagates the child process exit code. Internal commands currently include `run`, `tracker`, `schedule`, `review`, and `colab`.

**Exit codes:** `0` command success, `2` unknown command or not-yet-implemented placeholder, `127` missing target script, otherwise the wrapped script's exit code.

---

## structured logs

`lib/logger.mjs` writes NDJSON logs under `data/logs/run-<ISO>-<runId>.ndjson`. The CLI creates one `CAREER_OPS_RUN_ID` per invocation and forwards it to child processes. `data/logs/latest.ndjson` points to or copies the latest log, and rotation keeps the newest 50 run logs.

Each line is JSON with `ts`, `level`, `runId`, `cmd`, `msg`, and optional `event`/metadata. `career-ops run` emits `run_started`, `step_started`, `step_finished`, `step_failed`, and `run_finished` events.

---

## notifications

`lib/notify.mjs` emits user-visible events for unattended runs while always keeping a local audit trail. `career-ops run` calls it for dry-run wiring checks, required-step failures, newly queued high-fit reviews, follow-ups due, and successful runs that found something actionable. Notification failures never abort the run: file audit failures set `ok:false`, while Slack/Discord/desktop/email failures are recorded and warned.

Audit lines are written as NDJSON to `data/logs/notifications.ndjson` with `ts`, `runId`, `kind`, `severity`, `title`, `body`, `meta`, and per-channel results such as `{ "type":"slack", "ok":false, "reason":"missing SLACK_WEBHOOK" }`. The local file audit keeps the original body; outbound Slack/Discord/desktop bodies are redacted for common tokens, API keys, ngrok tokenized URLs, and email local parts before sending.

Current `kind` values from `career-ops run`:

- `run_dryrun` — emitted by `career-ops run --dry-run` so users can test wiring.
- `run_failed` — emitted when a required step aborts the run.
- `review_enqueued` — emitted when new high-fit applications are added to the review queue.
- `followups_due` — emitted when the follow-up cadence step reports due items.
- `run_completed` — emitted after a successful run with new high-fit reviews or follow-ups due.

Configure channels in `config/profile.yml` under `notifications.channels`. The file channel is implicit and always writes the audit line. Outbound channels honor `min_severity` with `info < warn < error`; skipped channels are recorded with `skipped_by_severity:true`.

```yaml
notifications:
  enabled: true
  channels:
    - type: file
      path: data/logs/notifications.ndjson
      min_severity: info
    - type: slack
      webhook_env: SLACK_WEBHOOK
      min_severity: warn
    - type: discord
      webhook_env: DISCORD_WEBHOOK
      min_severity: error
```

Slack and Discord read webhook URLs from environment variables named by `webhook_env`; missing secrets warn and record a failed channel result instead of crashing. `desktop` uses `node-notifier` only if that dependency already exists, otherwise it records `desktop channel not available`. `email` is a forward-compatible stub and currently records `email channel not implemented`.

Use `career-ops run --no-alerts` to skip notification calls entirely for that run. This is separate from `--no-notify`, which only suppresses the printed summary block.

---

## run

End-to-end autonomous pipeline orchestrator. Runs the day-to-day cycle from one command: preflight doctor, portal scan, batch evaluation, tracker merge, status normalization, deduplication, verification, and follow-up cadence. Each run writes structured NDJSON logs to `data/logs/run-<ISO>-<runId>.ndjson` with step status, duration, exit code, and failure reason.

```bash
career-ops run --dry-run                 # print ordered plan only
career-ops run --max-jobs 3              # cap batch evaluations
career-ops run --all                     # intentionally process the full queue
career-ops run --max-jobs 1 --auto-apply # evaluate, then open browser form-fill for new high-fit jobs
career-ops run --max-jobs 3 --auto-apply --auto-apply-limit 3
career-ops run --only=scan,pipeline      # run a subset
career-ops run --skip=verify,followup    # skip selected steps
career-ops run --engine=runner           # default: modes/runner.mjs
career-ops run --engine=claude           # opt into claude -p worker mode
career-ops run --no-alerts               # skip notification calls for this run
```

`--max-jobs` is forwarded to `batch-pipeline.mjs` via `CAREER_OPS_MAX_JOBS`; `--engine` is forwarded via `CAREER_OPS_ENGINE`. For safety, runs that include `pipeline` default to `CAREER_OPS_DEFAULT_MAX_JOBS` or 3 jobs; pass `--all` only when you intentionally want to process the whole queue. The default engine is `runner`, which uses `modes/runner.mjs` and the provider configured in `config/profile.yml` (or `STUB_LLM=1` for offline smoke tests). The `claude` engine is retained as an explicit compatibility path for users with Claude Code installed.

Add `--auto-apply` when you want the run to continue into the safe browser application helper for newly queued high-fit jobs. It auto-approves those new queue entries and launches `career-ops review approve <id> --browser`, which opens a visible browser, fills/uploads what it safely can, and **still never clicks final submit**. By default it opens at most one browser flow per run; raise that with `--auto-apply-limit N`.

**Exit codes:** `0` all required steps succeeded, `1` required step failed and the run aborted, `2` invalid flags or empty step selection.

---

## schedule

Installs, inspects, or removes recurring `career-ops run` execution. On macOS it writes a launchd plist at `~/Library/LaunchAgents/io.santifer.career-ops.plist`; on Linux it writes a systemd user service/timer at `~/.config/systemd/user/career-ops.{service,timer}`. Windows prints a `schtasks` command to copy/paste.

```bash
career-ops schedule install --every 3d --max-jobs 5
career-ops schedule status
career-ops schedule uninstall
career-ops schedule daemon --every 12h --max-jobs 3
career-ops schedule install --every 30m --dry-run
```

Supported cadences: `30m`, `12h`, `3d`, `1w`. Scheduled and manual runs share `data/.run.lock`, so overlapping runs are refused and stale locks are cleared automatically. `career-ops schedule status` reads the latest NDJSON log and reports last run time, final status, step count, and last error.

**Exit codes:** `0` success, `1` install/runtime failure, `2` invalid args.

---

## doctor

Validates that all prerequisites are in place: Node.js >= 20, dependencies installed, Playwright chromium, required files (`cv.md`, `config/profile.yml`, `modes/_profile.md`, `portals.yml`), LLM provider credentials, tracker parseability, stale run locks, disk space, fonts directory, and auto-creates `data/`, `output/`, `reports/` if missing.

```bash
npm run doctor
career-ops doctor --json
```

**Exit codes:** `0` all checks passed, `1` one or more checks failed (fix messages printed).

---

## login

Configures LLM provider credentials in `.env` without printing secrets back to the terminal. Supports Gemini, Anthropic, and OpenAI/OpenAI-compatible keys. Use `--no-validate` when storing a key for an endpoint that is temporarily offline or not reachable from the CLI.

```bash
career-ops login --status
career-ops login --provider gemini
career-ops login --provider anthropic
career-ops login --provider openai --no-validate
```

**Exit codes:** `0` success, `1` validation/write failure, `2` invalid args.

---

## verify

Health check for pipeline data integrity. Validates `data/applications.md` against seven rules: canonical statuses (per `templates/states.yml`), no duplicate company+role pairs, all report links point to existing files, scores match `X.XX/5` / `N/A` / `DUP`, rows have proper pipe-delimited format, no pending TSVs in `batch/tracker-additions/`, and no markdown bold in scores.

```bash
npm run verify
```

**Exit codes:** `0` pipeline clean (zero errors), `1` errors found. Warnings (e.g. possible duplicates) do not cause a non-zero exit.

---

## normalize

Maps non-canonical statuses to their canonical equivalents and strips markdown bold and dates from the status column. Aliases like `Enviada` become `Aplicado`, `CERRADA` becomes `Descartado`, etc. DUPLICADO info is moved to the notes column.

```bash
npm run normalize             # apply changes
npm run normalize -- --dry-run  # preview without writing
```

Creates a `.bak` backup of `applications.md` before writing.

**Exit codes:** `0` always (changes or no changes).

---

## dedup

Removes duplicate entries from `applications.md` by grouping on normalized company name + fuzzy role match. Keeps the entry with the highest score. If a removed entry had a more advanced pipeline status, that status is promoted to the keeper.

```bash
npm run dedup             # apply changes
npm run dedup -- --dry-run  # preview without writing
```

Creates a `.bak` backup before writing.

**Exit codes:** `0` always.

---

## merge

Merges batch tracker additions (`batch/tracker-additions/*.tsv`) into `applications.md`. Handles 9-column TSV, 8-column TSV, and pipe-delimited markdown formats. Detects duplicates by report number, entry number, and company+role fuzzy match. Higher-scored re-evaluations update existing entries in place.

```bash
npm run merge                 # apply merge
npm run merge -- --dry-run    # preview without writing
npm run merge -- --verify     # merge then run verify-pipeline
```

Processed TSVs are moved to `batch/tracker-additions/merged/`.

**Exit codes:** `0` success, `1` verification errors (with `--verify`).

---

## pdf

Renders an HTML file to a print-quality, ATS-parseable PDF via headless Chromium. Resolves font paths from `fonts/`, normalizes Unicode for ATS compatibility (em-dashes, smart quotes, zero-width characters), and reports page count and file size.

```bash
npm run pdf -- input.html output.pdf
npm run pdf -- input.html output.pdf --format=letter   # US letter
npm run pdf -- input.html output.pdf --format=a4        # A4 (default)
```

**Exit codes:** `0` PDF generated, `1` missing arguments or generation failure.

---

## sync-check

Validates that the career-ops setup is internally consistent: `cv.md` exists and is not too short, `config/profile.yml` exists with required fields, no hardcoded metrics in `modes/_shared.md` or `batch/batch-prompt.md`, and `article-digest.md` freshness (warns if older than 30 days).

```bash
npm run sync-check
```

**Exit codes:** `0` no errors (warnings allowed), `1` errors found.

---

## update:check

Checks whether a newer version of career-ops is available upstream. Outputs JSON to stdout:

```bash
npm run update:check
```

Possible JSON responses:

| `status` | Meaning |
|----------|---------|
| `up-to-date` | Local version matches remote |
| `update-available` | Newer version exists (includes `local`, `remote`, `changelog`) |
| `dismissed` | User dismissed the update prompt |
| `offline` | Could not reach GitHub |

**Exit codes:** `0` always.

---

## update

Applies the upstream update. Creates a backup branch (`backup-pre-update-{version}`), fetches from the canonical repo, checks out only system-layer files, runs `npm install`, and commits. User-layer files (`cv.md`, `config/profile.yml`, `data/`, etc.) are never touched.

```bash
npm run update
```

**Exit codes:** `0` success, `1` lock conflict or safety violation.

---

## rollback

Restores system-layer files from the most recent backup branch created during an update.

```bash
npm run rollback
```

**Exit codes:** `0` success, `1` no backup branch found or git error.

---

## liveness

Tests whether job posting URLs are still live using headless Chromium. Detects expired patterns (e.g. "job no longer available"), HTTP 404/410, ATS redirect patterns, and apply-button presence. Supports multi-language expired patterns (English, German, French).

```bash
npm run liveness -- https://example.com/job/123
npm run liveness -- https://a.com/job/1 https://b.com/job/2
npm run liveness -- --file urls.txt
```

Each URL gets a verdict: `active`, `expired`, or `uncertain` with a reason.

**Exit codes:** `0` all URLs active, `1` any expired or uncertain.

---

## scan

Zero-token portal scanner. Hits ATS APIs (Greenhouse, Ashby, Lever) and career pages directly — no LLM tokens consumed. Reads `portals.yml` for target companies and search queries, outputs matching listings to stdout and optionally appends to `data/pipeline.md`.

```bash
npm run scan
```

**Exit codes:** `0` scan completed, `1` configuration error or no portals.yml found.

---

## runner

Headless executor for `modes/*.md` prompts. Loads `modes/_shared.md` + `modes/_profile.md` + the requested mode file, substitutes `{{placeholders}}` from `--input key=value` flags (plus convenience flags `--jd` / `--cv` that read files), then calls the LLM provider configured in `config/profile.yml` under the `llm:` key. Replaces the need for an interactive AI CLI to interpret a mode.

Providers: `gemini` (default), `anthropic`, `openai`, `ollama`, `stub`. Each lives in `modes/providers/<name>.mjs`. The `stub` provider is deterministic and offline — used by `test-all.mjs` and any run with `STUB_LLM=1`.

```bash
# Real eval (uses config/profile.yml.llm.provider)
career-ops runner --mode oferta --jd examples/sample-jd.txt --save

# Force a specific provider/model
career-ops runner --mode oferta --jd jds/x.txt --provider anthropic --model claude-3-5-sonnet-latest --save

# Offline smoke test (no API keys needed)
STUB_LLM=1 career-ops runner --mode oferta --jd examples/sample-jd.txt --out /tmp/report.md
```

Auto-numbers reports under `reports/` as `NNN-<company>-<date>.md` when `--save` is given without `--out`. Parses a `---SCORE_SUMMARY---` block from the model output and surfaces score/archetype/legitimacy on stdout.

**Exit codes:** `0` success, `1` LLM error or missing key, `2` bad CLI args.

---

## review

Submit-review queue. The autonomous pipeline **never submits** applications (per [CLAUDE.md](../CLAUDE.md)) — instead, any evaluation scoring ≥ `review.apply_threshold` in [config/profile.yml](../config/profile.yml) (default 4.0) is appended to `data/review-queue.md` for your manual go/no-go. Implemented in [commands/review.mjs](../commands/review.mjs).

```bash
career-ops review list                  # pending items only (default)
career-ops review list --all            # all statuses
career-ops review show q-abc12345       # full report + metadata
career-ops review approve q-abc12345    # launches apply-assistant.mjs (still does NOT submit)
career-ops review submitted q-abc12345  # after manual submit, mark tracker Applied
career-ops review reject q-abc12345 --reason "salary too low"
career-ops review enqueue 642           # retro-queue an existing tracker row
```

Each queue entry has a stable id `q-<8hex>` derived from `sha1(company|role|url)`, so re-running the pipeline against the same offer is idempotent.
`approve --browser` may receive `--url` / `--report` from `apply-targets` so stale queue rows still get the best available report/PDF context.

**Exit codes:** `0` success, `1` entry not found / sub-process failure, `2` invalid args.

---

## apply --browser

Browser application assistant. The existing draft-only flow still works with `--questions` / `--file`; adding `--browser` launches the safe form-filling assistant. It fills low-risk factual fields from `config/profile.yml`, drafts simple free-text answers from the report/CV context, skips sensitive/legal/comp fields unless explicitly configured, writes an audit file, and **never clicks final submit**.

```bash
career-ops apply 657 --browser                 # visible Playwright browser
career-ops apply 657 --browser --dry-run       # detect/propose only
career-ops apply 657 --browser --fixture examples/apply-form-fixture.html --dry-run
career-ops review approve q-xxxxxxxx --browser # pass queued report into browser assistant
```

Audit files are written to `output/applications/{report}-{company}-{date}.md`. Final submission is always manual: review the browser, then click submit yourself only if everything is correct. If a custom select/autocomplete cannot be visibly verified after filling, the terminal/audit marks it as `needs review` instead of showing it as successfully filled, and prints a final filled/manual-check summary.

**Exit codes:** `0` success, `1` browser/detection failure, `2` invalid args.
