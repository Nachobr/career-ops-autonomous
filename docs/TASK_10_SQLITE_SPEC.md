# Task 10 — SQLite Tracker Mirror — Execution Spec

> Self-contained spec for one implementer LLM. Implement **only Task 10**. Do not
> touch other tasks' scope. When done, run `node test-all.mjs` and report the diff.

## Context & goal

`career-ops` tracks job applications in a markdown table at `data/applications.md`
(ES modules, Node ≥ 20, **no TypeScript**). Markdown is great for humans/AI but
fragile for scripts: concurrent writers (`scan` + a scheduled `run` + manual edits)
can corrupt the table.

Goal: add a **SQLite mirror** as the source of truth. `merge-tracker.mjs` writes to
SQLite first, then **regenerates** `data/applications.md` from the DB. Add a
migration command to import the existing markdown, and a `tracker export` command.

**Critical constraint:** the regenerated `data/applications.md` must remain
**byte-compatible** with the current format so the other 9 scripts that parse it keep
working unchanged (`scan.mjs`, `followup-cadence.mjs`, `verify-pipeline.mjs`,
`dedup-tracker.mjs`, `normalize-statuses.mjs`, `analyze-patterns.mjs`,
`gemini-eval.mjs`, `batch-pipeline.mjs`, `doctor.mjs`, plus `bin/career-ops.mjs`).

## Conventions you MUST follow

- ES modules (`.mjs`), Node ≥ 20, no TypeScript.
- Match the style of existing `lib/*.mjs` (`lib/logger.mjs`, `lib/dead-letter.mjs`).
  Root is resolved via `resolve(dirname(new URL('../package.json', import.meta.url).pathname))`.
- Never write user-specific data into system-layer files (`CLAUDE.md` → Data Contract).
- `data/applications.db` is user data — add it (and `-wal`/`-shm`) to `.gitignore`
  next to the existing individual `data/...` entries (there is no broad `data/*` rule).
- New scripts must be standalone-invocable (`node <file>.mjs --help` exits 0) AND
  routed through `bin/career-ops.mjs`.
- Add a `docs/SCRIPTS.md` entry for every new script/command.
- Add tests to `test-all.mjs` (see Tests below).

---

## The current markdown format (DO NOT CHANGE THE OUTPUT SHAPE)

Header + separator, then one row per application:

```
# Application Tracker

| ID | Fecha | Empresa | Rol | Score | Estado | PDF | Report |
|----|-------|---------|-----|-------|--------|-----|--------|
| 689 | 2026-05-29 | Wayve | Technical Product Manager - Robotaxi | N/A | Evaluated | ✅ | [689](reports/689-wayve-2026-05-29.md) |  |
```

Column semantics (pipe-split, trimmed — see `merge-tracker.mjs` `parseAppLine`, line ~163,
and `bin/career-ops.mjs` `parseTrackerRows`, line ~213):

| md column | index after `split('|')` | DB column | notes |
|-----------|--------------------------|-----------|-------|
| ID        | parts[1] | `id` INTEGER PK | the report number |
| Fecha     | parts[2] | `date` TEXT | `YYYY-MM-DD` |
| Empresa   | parts[3] | `company` TEXT | |
| Rol       | parts[4] | `role` TEXT | |
| Score     | parts[5] | `score` TEXT | stored verbatim e.g. `4.5/5` or `N/A` |
| Estado    | parts[6] | `status` TEXT | canonical state |
| PDF       | parts[7] | `pdf` TEXT | `✅` or empty |
| Report    | parts[8] | `report` TEXT | markdown link `[689](reports/...)` |
| (notes)   | parts[9] | `notes` TEXT | optional trailing column, often empty |

> IMPORTANT: store `score`, `pdf`, and `report` **as the exact strings** that appear
> in the markdown (don't normalize `4.5/5` → `4.5`, don't convert `✅` → `1`). This
> guarantees round-trip fidelity. The spec's original `REAL`/`0-1` schema idea is
> **superseded** by this string-faithful approach to avoid breaking 9 downstream
> parsers. Keep a derived numeric `score_num REAL` column too (parsed best-effort)
> for future querying, but regeneration uses the verbatim `score` string.

---

## Deliverable 1 — dependency

Add `better-sqlite3` to `package.json` `dependencies` (synchronous, no async churn,
matches the codebase's sync-fs style). Run `npm install better-sqlite3` so the
lockfile updates. If native build is a concern in CI, note it in the PR — but
`better-sqlite3` ships prebuilds for Node 20/22 on Linux/macOS.

---

## Deliverable 2 — `lib/tracker-db.mjs`

The DB access layer. Exports:

```js
export const DB_PATH;                 // data/applications.db (override via CAREER_OPS_TRACKER_DB)
export function openDb(path?)         // returns better-sqlite3 Database, runs migrations/PRAGMA
export function upsertApplication(db, row)   // INSERT ... ON CONFLICT(id) DO UPDATE
export function getApplications(db)   // SELECT * ORDER BY id ASC -> array of row objects
export function deleteApplication(db, id)
export function rowCount(db)
export function closeDb(db)
```

Requirements:
- `CAREER_OPS_TRACKER_DB` env override (mirror `CAREER_OPS_DEAD_LETTER` in
  `lib/dead-letter.mjs`) so tests use a temp DB and never touch real data.
- On open: `PRAGMA journal_mode = WAL;` and `PRAGMA busy_timeout = 5000;` (these two
  give safe concurrent reads/writes — the whole point of this task).
- Schema (create if not exists):
  ```sql
  CREATE TABLE IF NOT EXISTS applications (
    id         INTEGER PRIMARY KEY,
    date       TEXT NOT NULL,
    company    TEXT NOT NULL,
    role       TEXT NOT NULL,
    score      TEXT,              -- verbatim, e.g. "4.5/5" or "N/A"
    score_num  REAL,             -- derived best-effort (null if N/A)
    status     TEXT NOT NULL,
    pdf        TEXT,              -- verbatim "✅" or ""
    report     TEXT,             -- verbatim "[689](reports/...)"
    notes      TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS follow_ups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    kind TEXT, due_date TEXT, done INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY(application_id) REFERENCES applications(id)
  );
  CREATE TABLE IF NOT EXISTS dead_letter (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT, source TEXT, url TEXT, error TEXT, attempts INTEGER, run_id TEXT, meta TEXT
  );
  ```
  > `follow_ups` and `dead_letter` tables are created for forward-compat but Task 10
  > only needs to populate `applications`. Do NOT rewire `lib/dead-letter.mjs` (it
  > stays file-based — that's Task 9's contract). Leave the two extra tables empty.
- `upsertApplication` writes `updated_at = new Date().toISOString()` and derives
  `score_num` via the same regex used in `merge-tracker.mjs` `parseScore` (line ~158):
  `/(\d+(\.\d+)?)/` → float, else `null`.
- Use prepared statements and wrap multi-row writes in a transaction
  (`db.transaction(...)`) for atomicity + speed.

---

## Deliverable 3 — markdown (de)serialization helpers

Add to `lib/tracker-db.mjs` (or a sibling `lib/tracker-md.mjs`):

```js
export function parseTrackerMarkdown(text)  // -> array of row objects (id,date,company,role,score,status,pdf,report,notes)
export function renderTrackerMarkdown(rows) // -> full file string, byte-identical format
```

Requirements:
- `parseTrackerMarkdown` must reuse the exact parsing rules already in the codebase
  (port `parseAppLine` / `parseTrackerRows`): a data row matches `/^\|\s*\d+\s*\|/`,
  split on `|`, trim, require ≥ 9 cells, `id = parseInt(parts[1])` (skip if NaN/0).
- `renderTrackerMarkdown` must emit **exactly**:
  ```
  # Application Tracker

  | ID | Fecha | Empresa | Rol | Score | Estado | PDF | Report |
  |----|-------|---------|-----|-------|--------|-----|--------|
  | <id> | <date> | <company> | <role> | <score> | <status> | <pdf> | <report> |  |
  ```
  - Note the trailing ` |  |` (empty notes column) matches today's output — confirm
    against the current `data/applications.md` and `merge-tracker.mjs` `buildLine`
    (the row writer) before finalizing the exact spacing.
  - Row order: **descending insertion order is NOT required**; today new rows are
    inserted right after the header (newest first-ish). To stay safe, preserve the
    order returned by `getApplications` and make migration insert in the same order
    the markdown currently lists rows. Simplest correct choice: render rows in the
    **same order they appear in the source markdown** during migration, and for
    `merge`-driven regeneration, prepend new rows (newest first) to match current
    behavior. Verify round-trip equality (see Acceptance).

> The single hardest requirement of this task: **migrate → export must reproduce the
> current `data/applications.md` with zero meaningful diff** (whitespace-identical
> ideally). Build `renderTrackerMarkdown` by copying the existing line-writer, not by
> inventing new formatting.

---

## Deliverable 4 — `commands/migrate-tracker.mjs`

`career-ops migrate-tracker` — idempotent import of `data/applications.md` → DB.

- Parse `data/applications.md` with `parseTrackerMarkdown`.
- `upsertApplication` each row inside one transaction.
- Idempotent: running twice yields the same row count and same data (upsert on `id`).
- Flags: `--db <path>` (override), `--dry-run` (parse + report counts, no writes),
  `--help`/`-h` (exit 0).
- Print summary: `N rows imported (M inserted, K updated)`.
- Default export `async function (argv)` returning an exit code (match
  `commands/run.mjs` line ~460 pattern).

---

## Deliverable 5 — wire `merge-tracker.mjs` to DB-first

Modify `merge-tracker.mjs` so the **DB is the source of truth**:

1. Open the DB (auto-create + auto-migrate from markdown if the DB is empty but the
   markdown has rows — call the migration path so existing users don't lose data on
   first DB run).
2. Apply the parsed TSV additions/updates via `upsertApplication` (instead of, or in
   addition to, the current in-memory markdown splice).
3. **Regenerate** `data/applications.md` from the DB via `renderTrackerMarkdown` +
   `writeFileSync`.
4. Keep the existing TSV → `merged/` move behavior and console summary unchanged.

> Keep the change surgical. The current dedupe/fuzzy-match logic (`roleFuzzyMatch`,
> score-comparison on duplicates, lines ~330-360) should still decide insert-vs-update;
> just route the final write through the DB + regenerate instead of splicing strings.
> If full DB-first rewiring is too invasive, the acceptable MVP is: after the existing
> markdown write, **sync the DB from the freshly written markdown** (migrate), so the
> DB stays a faithful mirror. Prefer true DB-first, but document whichever you chose.

---

## Deliverable 6 — `tracker export`

Extend the existing `tracker` command (currently `internal: 'tracker'` in
`bin/career-ops.mjs`, handled by `printTrackerSummary`) OR add a subcommand:

- `career-ops tracker export --format=md|csv|json` reads from the **DB** and prints to
  stdout (or `--out <file>`).
  - `md` → `renderTrackerMarkdown(getApplications(db))`
  - `csv` → header row + one line per app (quote fields containing `,`/`"`)
  - `json` → `JSON.stringify(getApplications(db), null, 2)`
- `career-ops tracker` (no args) keeps its current summary output (do not break it).
- `--help` exits 0.

Wire any new command file through the `COMMANDS` table / `runInternal` mapping
(`runInternal` builds `commands/<name>.mjs`, line ~299).

---

## Deliverable 7 — docs + gitignore

- `.gitignore`: add `data/applications.db`, `data/applications.db-wal`,
  `data/applications.db-shm`.
- `docs/SCRIPTS.md`: entries for `lib/tracker-db.mjs`, `commands/migrate-tracker.mjs`,
  and `tracker export`.
- Update `docs/AUTONOMOUS_CLI_TODO.md` Task 10 status if a convention exists.

---

## Deliverable 8 — Tests (`test-all.mjs`)

All tests must use `CAREER_OPS_TRACKER_DB` pointed at a temp file — **never touch the
real `data/applications.db` or `data/applications.md`**. Use the temp-dir pattern
already in `test-all.mjs` (`mkdtempSync(join(tmpdir(), ...))`).

1. **Syntax**: `node --check lib/tracker-db.mjs`, `commands/migrate-tracker.mjs`
   (+ `lib/tracker-md.mjs` if created) — add explicit `--check` lines like the
   existing `lib/notify.mjs` checks (~line 324).
2. **Round-trip MD → DB → MD**: take a fixed sample markdown string (3-4 rows
   including an `N/A` score, a `4.5/5` score, and a `SKIP` status), parse → upsert →
   `renderTrackerMarkdown`, and assert the output **equals** the input (modulo
   trailing newline). This is the acceptance gate.
3. **Idempotent migration**: import the sample twice; assert `rowCount` is stable and
   a re-import doesn't duplicate rows.
4. **score_num derivation**: assert `4.5/5` → `4.5`, `N/A` → `null`.
5. **Concurrency smoke** (best-effort): open two DB connections, write from both in
   sequence with WAL on, assert no error and final `rowCount` correct.
6. **CLI help**: `career-ops migrate-tracker --help` and
   `career-ops tracker export --help` exit 0.

---

## Acceptance criteria

- `npm install` succeeds with `better-sqlite3` (prebuild on Node 20/22).
- `career-ops migrate-tracker` on the **current real tracker** produces a DB with the
  **same row count** as the markdown table (today: 27 rows).
- `career-ops tracker export --format=md` reproduces a valid `data/applications.md`
  that `career-ops verify` reports **clean** (0 errors).
- Running `career-ops run` (the full pipeline) still passes `verify` — i.e. the
  DB-first `merge` didn't change the markdown shape.
- `node test-all.mjs` passes with no network/keys; the MD↔DB round-trip test is green.
- Two concurrent writers (simulate with `&` or two connections) don't corrupt the DB.

## Out of scope

- Retry/dead-letter changes (Task 9 — leave `lib/dead-letter.mjs` file-based).
- Populating `follow_ups` / `dead_letter` tables (schema only, for later).
- Changing the markdown column set or language (keep Spanish headers `Fecha/Empresa/Rol/Estado`).

## Files to create / modify (summary)

| Action | Path |
|--------|------|
| create | `lib/tracker-db.mjs` (+ optional `lib/tracker-md.mjs`) |
| create | `commands/migrate-tracker.mjs` |
| modify | `merge-tracker.mjs` (DB-first write + regenerate) |
| modify | `bin/career-ops.mjs` (`migrate-tracker` command, `tracker export`) |
| modify | `package.json` (add `better-sqlite3`) + lockfile |
| modify | `test-all.mjs` (tests above) |
| modify | `.gitignore`, `docs/SCRIPTS.md` |

## Suggested implementation order

1. Add `better-sqlite3`; build `lib/tracker-db.mjs` (schema, upsert, get) + unit tests.
2. Build `parseTrackerMarkdown` / `renderTrackerMarkdown` by porting existing
   `merge-tracker.mjs` line writer; get the **MD→DB→MD round-trip test green first**.
3. `commands/migrate-tracker.mjs` + CLI wiring + `--help` test.
4. Run migration on the real tracker; `tracker export --format=md`; diff against
   `data/applications.md` until zero meaningful diff.
5. Rewire `merge-tracker.mjs` to DB-first; confirm `career-ops run` → `verify` clean.
6. `tracker export` formats, docs, gitignore.
