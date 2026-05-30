# Autonomous Mode

`career-ops` runs the entire job-search pipeline from a **single CLI binary** — no
interactive AI coding tool required for the day-to-day loop. This guide covers the
full lifecycle: **install → login → run → schedule → review → apply**.

> **Hard safety rule:** automation can *find, evaluate, draft, and fill* applications,
> but it **never submits** them. You always make the final submit click yourself.

---

## 1. Install

```bash
git clone <your-fork> career-ops
cd career-ops
npm install                 # installs deps incl. Playwright + better-sqlite3
npx playwright install chromium
npm install -g .            # optional: exposes `career-ops` globally
```

Then create your config from the templates:

```bash
cp config/profile.example.yml config/profile.yml
cp .env.example .env
# edit cv.md, config/profile.yml, portals.yml with your details
```

Validate everything is ready:

```bash
career-ops doctor           # checks Node, Playwright, files, LLM key, tracker, disk
```

`doctor` is also the preflight gate for `run` — it aborts the pipeline early with an
actionable error if a required check fails.

---

## 2. Login (LLM provider)

The pipeline needs one LLM backend to evaluate job descriptions. Pick a provider in
`config/profile.yml`:

```yaml
llm:
  provider: gemini          # anthropic | openai | gemini | ollama
  model: gemini-2.0-flash
  max_tokens: 4096
  temperature: 0.3
  fallback: ollama
```

Store the credential (written to `.env`, never printed back):

```bash
career-ops login --provider gemini      # prompts for the key, validates it
career-ops login --status               # show which providers are configured
```

### Free option: Google Colab backend

Run a model on a free Colab GPU and tunnel it via ngrok (OpenAI-compatible endpoint):

```bash
career-ops colab set --base https://xxxx.ngrok-free.app --model qwen2.5:14b-instruct-q4_K_M
career-ops colab test       # pings /v1/models, lists served models
career-ops colab status     # show current LOCAL_LLM_* config
```

When `LOCAL_LLM_BASE_URL` is set, `run` routes evaluations through Colab at **$0 token
cost**.

### Offline / CI

Set `STUB_LLM=1` to force a deterministic offline provider — useful for smoke-testing
the plumbing without any API key or network.

---

## 3. Run (end-to-end)

`career-ops run` orchestrates the whole pipeline:

```
doctor → scan → pipeline (evaluate) → merge → normalize → dedup → verify → followup
```

```bash
career-ops run --dry-run        # print the ordered plan and exit
career-ops run --max-jobs 3     # full pipeline, cap evaluations at 3
career-ops run --only scan,verify   # run a subset
career-ops run --engine=runner  # LLM engine (default; or =claude to shell out)
```

Each step logs status, duration, and exit code. A per-run NDJSON log is written to
`data/logs/run-<ISO>.json`, with `data/logs/latest.ndjson` pointing at the most recent.

Inspect results afterwards:

```bash
career-ops tracker              # status counts + latest entry
career-ops verify               # tracker health check
career-ops tracker export --format=md   # regenerate markdown from the SQLite mirror
```

### Resilience (retry + dead-letter)

Scraping, LLM, PDF, and portal calls are wrapped with exponential-backoff retries, so
one flaky URL never aborts the batch. Permanent failures are recorded in
`data/dead-letter.ndjson`:

```bash
career-ops retry-dead-letter --list    # show queued failures
career-ops retry-dead-letter           # requeue failed URLs into the pipeline
career-ops retry-dead-letter --clear   # empty the queue
```

### Tracker storage

The tracker is mirrored to SQLite (`data/applications.db`, WAL mode) as the source of
truth, with `data/applications.md` regenerated from it. This makes concurrent runs
(e.g. a scheduled run while you edit) safe. Import an existing markdown tracker once:

```bash
career-ops migrate-tracker
```

---

## 4. Schedule (set & forget)

Install a recurring run via the OS scheduler (launchd on macOS, systemd user timer on
Linux):

```bash
career-ops schedule install --every 3d --max-jobs 3
career-ops schedule status        # next-run / last-run / last-exit-code
career-ops schedule uninstall
```

Cadence accepts `30m`, `12h`, `3d`, `1w`. For containers/tmux, use the foreground
daemon instead of an OS unit:

```bash
career-ops schedule daemon --every 12h --max-jobs 3
```

A lock file at `data/.run.lock` prevents overlapping runs (stale locks from dead
processes auto-clear).

---

## 5. Review (approval queue)

For unattended runs, high-scoring offers are queued instead of acted on. The pipeline
enqueues evaluations scoring ≥ `review.apply_threshold` (default 4.0) into
`data/review-queue.md`.

```bash
career-ops review list                  # pending items with score/company/role
career-ops review show <id>             # full evaluation report
career-ops review reject <id> --reason "location"   # marks tracker SKIP
career-ops review approve <id>          # launches the apply assistant (drafts only)
```

Nothing is ever submitted from the queue — `approve` only opens the assistant.

---

## 6. Apply (assisted form-filling)

The apply assistant helps with the browser work but **stops before final submit**.

```bash
career-ops apply <url|report|company>                 # draft answers for copy/paste
career-ops apply <url|report|company> --browser       # open browser, fill safe fields
career-ops apply <url|report|company> --browser --dry-run   # detect fields, no typing
career-ops review approve <id> --browser              # same, from the queue
```

Behavior:
- Fills low-risk factual fields (name, email, location, LinkedIn/GitHub/portfolio).
- Drafts free-text answers from your report + CV.
- **Pauses** on sensitive/legal fields (work authorization, visa, salary, demographics)
  unless you've set explicit answers in `config/profile.yml`.
- Detects final submit buttons (`Submit`, `Apply now`, `Enviar`, …) and **never clicks
  them** — it stops and asks you to review and submit manually.
- Writes an audit draft to `output/applications/{report}-{company}-{date}.md`.

After you manually submit, record it so the tracker/queue update:

```bash
career-ops review submitted <id>
```

---

## Notifications (optional)

Configure outbound channels in `config/profile.yml` to be told when something
interesting happens (high-score offer, failure, follow-up due):

```yaml
notifications:
  enabled: true
  channels:
    - type: file
      path: data/logs/notifications.ndjson
    - type: slack
      webhook_env: SLACK_WEBHOOK
```

All events are always appended to `data/logs/notifications.ndjson` regardless of
channels (audit trail). Severity levels: `info`, `warn`, `error`.

---

## Daily loop, in one place

```bash
career-ops doctor          # 1. preflight
career-ops run --max-jobs 5   # 2. scan + evaluate + tracker
career-ops review list     # 3. see what's worth applying to
career-ops apply <id> --browser   # 4. fill the form, you click submit
career-ops review submitted <id>  # 5. mark it applied
```

Or let the scheduler do steps 1–2 on a cadence and just check the review queue when
you have time.

See [SCRIPTS.md](SCRIPTS.md) for the full per-script reference.
