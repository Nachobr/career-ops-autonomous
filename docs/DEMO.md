# career-ops — Live Demo Script

A ~10–15 min walkthrough of the fully autonomous, single-CLI job-search pipeline.
Each section has a **say**, a **run**, and a **point out** so you can narrate while it runs.

> One-line pitch: *"Companies use AI to filter candidates — career-ops gives the
> candidate AI to choose companies, fill the forms, and never auto-submit."*

---

## 0. Before the demo (setup — do this off-camera)

```bash
cd career-ops
git pull                              # latest main
npm install                           # deps incl. better-sqlite3 + playwright
npx playwright install chromium       # if not already installed
```

**LLM backend** — pick ONE:

```bash
# Option A: free Google Colab GPU (start the Colab notebook first, copy the ngrok URL)
career-ops colab set --base https://<your-ngrok>.ngrok-free.app --model qwen2.5:14b-instruct-q4_K_M
career-ops colab test                 # must print "endpoint reachable (HTTP 200)"

# Option B: hosted provider
career-ops login --provider gemini

# Option C: offline safety net (no network/keys — deterministic, great if wifi is flaky)
export STUB_LLM=1
```

> **Demo tip:** keep `STUB_LLM=1` ready as a fallback. If Colab/ngrok drops mid-demo,
> the whole pipeline still runs end-to-end with deterministic output.

Have a terminal with a readable font size. Optional: a second terminal for the dashboard.

---

## 1. The single entrypoint (30s)

**Say:** "Everything is one binary now — no AI coding CLI in the loop for daily use."

**Run:**
```bash
career-ops --help
career-ops --version
```

**Point out:** ~25 subcommands, aliases (`dlq`, `health`), and that all args forward to
the underlying scripts.

---

## 2. Preflight: doctor (45s)

**Say:** "Before anything runs, doctor validates the whole environment — and it's the
fail-fast gate for the autonomous run."

**Run:**
```bash
career-ops doctor
career-ops doctor --json | head -20      # machine-readable for CI/automation
```

**Point out:** Node version, Playwright, required files, **LLM provider credential
check**, tracker parses, stale-lock detection, disk space.

---

## 3. Scan portals — zero-token discovery (1 min)

**Say:** "It scans 70+ companies straight off their ATS APIs — no LLM tokens spent
just to find jobs."

**Run:**
```bash
career-ops scan
```

**Point out:**
- Companies scanned / jobs found / filtered by title & location / dedup / new offers.
- The **retry logic** in action: `↻ retry 1 after 509ms…` on flaky portals.
- Errors are captured, not fatal — segue to the dead-letter queue (section 7).

---

## 4. The autonomous run — the headline (2–3 min)

**Say:** "This is the whole thing in one command: scan → evaluate → PDF → tracker →
verify → follow-ups."

**Run:**
```bash
career-ops run --dry-run                 # show the plan first
career-ops run --max-jobs 1              # real, capped to 1 eval so it's fast on stage
```

**Point out while it runs:**
- The ordered **plan** and the safety cap.
- Live engine line: `llm=colab/ngrok … model=…` (or stub).
- Each step prints status + duration + exit code.
- A new evaluation report in `reports/`, a tailored **ATS PDF** in `output/`.
- `verify` ends with **🟢 Pipeline is clean**.
- The per-run log: `data/logs/run-<ISO>.ndjson` (mention `latest.ndjson`).

---

## 5. The tracker + SQLite mirror (1 min)

**Say:** "The tracker is human-readable markdown, but it's mirrored to SQLite as the
source of truth so concurrent runs can't corrupt it."

**Run:**
```bash
career-ops tracker                        # status counts + latest
career-ops migrate-tracker                # import markdown → SQLite (idempotent)
career-ops tracker export --format=json | head -20
career-ops tracker export --format=md  | head -6
career-ops verify                         # integrity health check
```

**Point out:** export reproduces the markdown **byte-identical** from the DB; WAL mode =
safe concurrent access; idempotent migration.

---

## 6. Review queue — human-in-the-loop (1 min)

**Say:** "On autonomous runs, high-scoring offers don't get acted on — they queue for
your approval. Nothing is ever submitted on your behalf."

**Run:**
```bash
career-ops review list                    # pending items ≥ apply_threshold (4.0)
career-ops review show <id>               # full evaluation report
```

**Point out:** stable queue IDs, `approve`/`reject`/`submitted` lifecycle, threshold
filtering.

---

## 7. Resilience: retry + dead-letter queue (1 min)

**Say:** "Scraping and LLMs fail intermittently. One flaky URL should never kill a
batch — so failures retry with backoff, then land in a dead-letter queue."

**Run:**
```bash
career-ops retry-dead-letter --list       # failures captured during scan/eval
career-ops retry-dead-letter --dry-run    # what it WOULD requeue
# career-ops retry-dead-letter            # actually requeue into pipeline.md
```

**Point out:** `data/dead-letter.ndjson`, per-source tags (`scrape`/`llm`/`pdf`/`scan`),
attempts count, one-command recovery.

---

## 8. Browser apply assistant — fill, never submit (2 min) ⭐ crowd-pleaser

**Say:** "It opens the real application page, fills the safe fields, drafts the free-text
answers from your CV — and **stops** at the submit button. You always click submit."

**Run (dry-run first, no typing):**
```bash
career-ops apply <url|report|company> --browser --dry-run
```
**Then the live fill:**
```bash
career-ops apply <url|report|company> --browser
```

**Point out:**
- Detects Greenhouse/Lever/Ashby/Workday fields.
- Fills name/email/location/LinkedIn; drafts free-text from the report + CV.
- **Pauses** on sensitive/legal fields (visa, salary, demographics) unless configured.
- Detects the final **Submit** button and refuses to click it — terminal + browser
  message tells you to review and submit manually.
- Writes an audit draft to `output/applications/{report}-{company}-{date}.md`.

After you manually submit:
```bash
career-ops review submitted <id>          # marks queue + tracker as Applied
```

---

## 9. Scheduling — set & forget (45s)

**Say:** "Make it run itself on a cadence with the OS scheduler — or a foreground daemon
for containers."

**Run:**
```bash
career-ops schedule install --every 3d --max-jobs 3 --dry-run   # show the plist/unit
career-ops schedule status
# career-ops schedule daemon --every 12h --max-jobs 3           # foreground mode
```

**Point out:** launchd (macOS) / systemd timer (Linux), cadence parsing (`30m/12h/3d/1w`),
lock file prevents overlapping runs.

---

## 10. Dashboard TUI (optional, 45s)

**Say:** "A terminal dashboard to browse the pipeline visually."

**Run:**
```bash
cd dashboard && go build -o career-dashboard . && ./career-dashboard --path ..
```

**Point out:** filter tabs, sort modes, inline status changes. (`q` to quit.)

---

## 11. Quality bar (30s)

**Say:** "All of this is regression-guarded."

**Run:**
```bash
node test-all.mjs --quick
```

**Point out:** **141 tests, 0 failures**, no network/keys required (stub provider), CI
runs on Node 20 + 22.

---

## Closing line

> "From one command: it finds the jobs worth your time, evaluates fit against your CV,
> tailors a CV PDF, tracks everything in a corruption-safe store, retries through
> flakiness, and even fills the forms — while never taking the final submit decision
> away from you. Fully autonomous, but you stay in control."

---

## Quick reference — full demo in copy-paste order

```bash
career-ops --help
career-ops doctor
career-ops scan
career-ops run --dry-run
career-ops run --max-jobs 1
career-ops tracker
career-ops tracker export --format=md | head -6
career-ops verify
career-ops review list
career-ops retry-dead-letter --list
career-ops apply <id> --browser --dry-run
career-ops apply <id> --browser
career-ops schedule status
node test-all.mjs --quick
```

## If something breaks on stage
- LLM/Colab down → `export STUB_LLM=1` and re-run (deterministic, offline).
- Scan slow / timeouts → expected for some portals; point at the retry/DLQ as the
  feature handling it, then move on.
- Browser apply can't find a fixture → use `--dry-run` to show detection logic.
- Lock file complaint → `rm data/.run.lock` (stale lock from a killed run).
```
