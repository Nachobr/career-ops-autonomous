/**
 * commands/review.mjs — Manage the submit-review queue
 *
 * Implements Task 5 of docs/AUTONOMOUS_CLI_TODO.md.
 *
 * The autonomous pipeline never submits applications (see CLAUDE.md). Instead,
 * any evaluation scoring ≥ `review.apply_threshold` (default 4.0) is appended
 * to data/review-queue.md with status=pending. The user reviews the queue,
 * approves the items worth pursuing, and either:
 *   - `review approve q-xxxxxxxx`  → launches apply-assistant.mjs
 *   - `review reject  q-xxxxxxxx`  → marks the tracker row as SKIP
 *
 * Subcommands:
 *   review list      [--pending|--approved|--rejected|--all]
 *   review show      <id>
 *   review approve   <id>
 *   review reject    <id> [--reason "..."]
 *   review enqueue   <reportNum>          (retroactively queue an existing report)
 *
 * Exposed via:  career-ops review <subcommand> ...
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PATHS = {
  queue:       join(ROOT, 'data', 'review-queue.md'),
  apps:        existsSync(join(ROOT, 'data', 'applications.md'))
                 ? join(ROOT, 'data', 'applications.md')
                 : join(ROOT, 'applications.md'),
  reports:     join(ROOT, 'reports'),
  config:      join(ROOT, 'config', 'profile.yml'),
  applyScript: join(ROOT, 'apply-assistant.mjs'),
};

const HEADER =
`# Review Queue

Pipeline-generated offers awaiting your human go/no-go. The autonomous loop
never submits — see CLAUDE.md.

| ID | Added | Score | Status | Company | Role | URL | Report |
|----|-------|-------|--------|---------|------|-----|--------|
`;

// ── ANSI ────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const bold   = (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s;
const dim    = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;
const green  = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red    = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const cyan   = (s) => isTTY ? `\x1b[36m${s}\x1b[0m` : s;

// ── Queue I/O ───────────────────────────────────────────────────

function ensureQueueFile() {
  mkdirSync(dirname(PATHS.queue), { recursive: true });
  if (!existsSync(PATHS.queue)) writeFileSync(PATHS.queue, HEADER, 'utf-8');
}

function readQueue() {
  ensureQueueFile();
  const text = readFileSync(PATHS.queue, 'utf-8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('| q-')) continue;
    const parts = line.split('|').map(s => s.trim());
    // index 0 is "" (leading pipe); fields start at 1
    if (parts.length < 9) continue;
    out.push({
      id:      parts[1],
      added:   parts[2],
      score:   parts[3],
      status:  parts[4],
      company: parts[5],
      role:    parts[6],
      url:     parts[7],
      report:  parts[8],
    });
  }
  return out;
}

function writeQueue(rows) {
  const lines = rows.map(r =>
    `| ${r.id} | ${r.added} | ${r.score} | ${r.status} | ${r.company} | ${r.role} | ${r.url} | ${r.report} |`
  );
  writeFileSync(PATHS.queue, HEADER + lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');
}

function makeId(company, role, url) {
  const h = createHash('sha1').update(`${company}|${role}|${url}`).digest('hex');
  return `q-${h.slice(0, 8)}`;
}

function parseScoreNumber(s) {
  if (!s) return 0;
  const m = String(s).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// ── Config ──────────────────────────────────────────────────────

async function loadThreshold() {
  if (!existsSync(PATHS.config)) return 4.0;
  try {
    const yaml = (await import('js-yaml')).default;
    const doc = yaml.load(readFileSync(PATHS.config, 'utf-8')) || {};
    const t = doc?.review?.apply_threshold;
    return typeof t === 'number' && t >= 0 ? t : 4.0;
  } catch {
    return 4.0;
  }
}

// ── Programmatic API (used by batch-pipeline.mjs) ──────────────

/**
 * Enqueue an item if its score ≥ threshold. Idempotent on (company, role, url).
 * Returns the queue entry (existing or newly added), or null if below threshold.
 */
export async function enqueueIfQualified({ company, role, url, report, score, threshold = null }) {
  const t = threshold ?? await loadThreshold();
  const s = parseScoreNumber(score);
  if (s < t) return null;

  const id = makeId(company || '', role || '', url || '');
  const rows = readQueue();
  const existing = rows.find(r => r.id === id);
  if (existing) return existing;

  const entry = {
    id,
    added:   new Date().toISOString().slice(0, 10),
    score:   String(score).includes('/') ? score : `${s}/5`,
    status:  'pending',
    company: company || 'Unknown',
    role:    role || 'Unknown',
    url:     url || '-',
    report:  report || '-',
  };
  rows.push(entry);
  writeQueue(rows);
  return entry;
}

// ── Tracker helpers ─────────────────────────────────────────────

function findTrackerRowByReport(reportLink) {
  if (!existsSync(PATHS.apps)) return { lines: [], idx: -1, row: null };
  const lines = readFileSync(PATHS.apps, 'utf-8').split('\n');
  // Match by report markdown link presence
  const idx = lines.findIndex(l => l.startsWith('|') && reportLink && l.includes(reportLink));
  if (idx === -1) return { lines, idx: -1, row: null };
  return { lines, idx, row: lines[idx] };
}

function setTrackerStatus(reportLink, newStatus, note = '') {
  const { lines, idx } = findTrackerRowByReport(reportLink);
  if (idx === -1) return false;
  // Replace the 6th pipe-delimited field (status column)
  const cells = lines[idx].split('|');
  // Format: |  | num | date | company | role | score | status | pdf | report | notes |
  // cells:   0   1     2     3        4     5     6       7     8       9      10
  if (cells.length < 10) return false;
  cells[6] = ` ${newStatus} `;
  if (note) {
    cells[cells.length - 2] = ` ${(cells[cells.length - 2] || '').trim() ? cells[cells.length - 2].trim() + ' · ' : ''}${note} `;
  }
  lines[idx] = cells.join('|');
  writeFileSync(PATHS.apps, lines.join('\n'), 'utf-8');
  return true;
}

function reportLinkForNum(reportNum) {
  const padded = String(reportNum || '').padStart(3, '0');
  if (!/^\d{3}$/.test(padded) || !existsSync(PATHS.reports)) return '';
  const file = readdirSync(PATHS.reports).find(f => f.startsWith(`${padded}-`) && f.endsWith('.md'));
  return file ? `[${padded}](reports/${file})` : '';
}

// Resolve the apply URL for a queue row: prefer the stored URL, otherwise read
// **URL:** from the linked report file. Returns '' when neither is available
// (e.g. legacy rows enqueued before URLs were stored, whose report file has
// since been deleted) — such rows can never be opened in the browser.
function resolveQueueUrl(row) {
  if (row.url && row.url !== '-' && /^https?:\/\//i.test(row.url)) return row.url;
  const m = row.report && row.report.match(/\((reports\/[^)]+)\)/);
  if (m) {
    const p = join(ROOT, m[1]);
    if (existsSync(p)) {
      const um = readFileSync(p, 'utf-8').match(/^\*\*URL:\*\*\s*(\S+)/m);
      if (um && /^https?:\/\//i.test(um[1])) return um[1];
    }
  }
  return '';
}

// ── Subcommand impls ────────────────────────────────────────────

function cmdList(filter) {
  const rows = readQueue();
  const filtered = filter === 'all'
    ? rows
    : rows.filter(r => r.status === filter);
  if (filtered.length === 0) {
    console.log(dim(`(queue empty — filter=${filter})`));
    return 0;
  }
  // Pretty print
  const widths = {
    id: Math.max(4, ...filtered.map(r => r.id.length)),
    score: 7,
    status: 9,
    company: Math.max(7, ...filtered.map(r => r.company.length)),
    role: Math.max(4, ...filtered.map(r => r.role.length)),
  };
  const pad = (s, w) => String(s).padEnd(w);
  const header = `${pad('ID', widths.id)}  ${pad('SCORE', widths.score)}  ${pad('STATUS', widths.status)}  ${pad('COMPANY', widths.company)}  ROLE`;
  console.log(bold(header));
  console.log(dim('-'.repeat(header.length + 20)));
  for (const r of filtered) {
    const statusColored = r.status === 'pending'  ? yellow(pad(r.status, widths.status))
                        : r.status === 'approved' ? green(pad(r.status, widths.status))
                        : red(pad(r.status, widths.status));
    console.log(`${cyan(pad(r.id, widths.id))}  ${pad(r.score, widths.score)}  ${statusColored}  ${pad(r.company, widths.company)}  ${r.role}`);
  }
  return 0;
}

function cmdShow(id) {
  const row = readQueue().find(r => r.id === id);
  if (!row) { console.error(`No queue entry: ${id}`); return 1; }
  console.log(bold(`${row.id}  ${row.score}  [${row.status}]`));
  console.log(`Company:  ${row.company}`);
  console.log(`Role:     ${row.role}`);
  console.log(`URL:      ${row.url}`);
  console.log(`Report:   ${row.report}`);
  console.log(`Added:    ${row.added}`);

  // Try to print the actual report content
  const linkMatch = row.report.match(/\((reports\/[^)]+)\)/);
  if (linkMatch) {
    const p = join(ROOT, linkMatch[1]);
    if (existsSync(p)) {
      console.log('\n' + dim('─'.repeat(70)));
      console.log(readFileSync(p, 'utf-8'));
    }
  }
  return 0;
}

function cmdApprove(id, opts = {}) {
  const rows = readQueue();
  const i = rows.findIndex(r => r.id === id);
  if (i === -1) { console.error(`No queue entry: ${id}`); return 1; }
  const row = rows[i];
  const forwardedUrlIdx = Array.isArray(opts.forwardArgs) ? opts.forwardArgs.indexOf('--url') : -1;
  const forwardedUrl = forwardedUrlIdx !== -1 ? opts.forwardArgs[forwardedUrlIdx + 1] : '';
  const forwardedReportIdx = Array.isArray(opts.forwardArgs) ? opts.forwardArgs.indexOf('--report') : -1;
  const forwardedReport = forwardedReportIdx !== -1 ? opts.forwardArgs[forwardedReportIdx + 1] : '';

  // Resolve report number from the report link "[NNN](reports/NNN-...md)"
  const numMatch = forwardedReport ? [null, String(forwardedReport).padStart(3, '0')] : row.report.match(/\[(\d{3})\]/);
  const reportPathMatch = row.report.match(/\((reports\/[^)]+)\)/);
  const forwardedReportLink = forwardedReport ? reportLinkForNum(forwardedReport) : '';
  const reportPath = forwardedReportLink
    ? join(ROOT, forwardedReportLink.match(/\((reports\/[^)]+)\)/)?.[1] || '__missing_report__')
    : reportPathMatch ? join(ROOT, reportPathMatch[1]) : null;
  let url = forwardedUrl && /^https?:\/\//i.test(forwardedUrl)
    ? forwardedUrl
    : row.url && row.url !== '-' && /^https?:\/\//i.test(row.url) ? row.url : '';
  if (!url && reportPath && existsSync(reportPath)) {
    const reportText = readFileSync(reportPath, 'utf-8');
    const urlMatch = reportText.match(/^\*\*URL:\*\*\s*(\S+)/m);
    if (urlMatch) url = urlMatch[1];
  }
  if (opts.browser && !url) {
    console.error(`Cannot launch browser for ${id}: queue row has no URL${reportPath && !existsSync(reportPath) ? ` and report is missing (${reportPathMatch[1]})` : ''}.`);
    console.error('Pick another pending item with an existing report/URL, or re-enqueue after regenerating the report.');
    return 1;
  }

  if (row.status === 'approved') {
    console.log(yellow(`Already approved: ${id}`));
  }
  rows[i] = { ...row, status: 'approved', report: forwardedReportLink || row.report, url: url || row.url };
  writeQueue(rows);
  console.log(green(`✔ Approved ${id}`));
  console.log(dim('Launching apply-assistant. The assistant DRAFTS answers — it does not submit.'));
  const args = [];
  if (numMatch) args.push('--report', numMatch[1]);
  else if (row.company && row.company !== 'Unknown') args.push('--company', row.company);
  if (url) args.push('--url', url);
  if (opts.browser) args.push('--browser');
  // In a real (non-dry) browser run, ask the user whether they submitted once
  // they close the window — the assistant signals "yes" with exit code 10 so we
  // can flip the queue + tracker to Applied without a separate manual command.
  const wantConfirm = opts.browser && opts.confirmSubmit !== false && !(Array.isArray(opts.forwardArgs) && opts.forwardArgs.includes('--dry-run'));
  if (wantConfirm) args.push('--confirm-submit');
  if (Array.isArray(opts.forwardArgs)) args.push(...opts.forwardArgs);

  const child = spawn(process.execPath, [PATHS.applyScript, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      // Exit code 10 = user confirmed they submitted this application.
      if (code === 10) {
        const res = markSubmitted(id, `Submitted via apply assistant ${new Date().toISOString().slice(0, 10)}`);
        if (res.found) {
          console.log(green(`✔ ${id} marked submitted`) + (res.trackerUpdated ? green('  · tracker → Applied') : dim('  · tracker row not found')));
        }
        return resolve(0);
      }
      resolve(code ?? 0);
    });
    child.on('error', (e) => { console.error(`apply-assistant failed: ${e.message}`); resolve(1); });
  });
}

async function cmdApplyAll(opts = {}) {
  let pending = readQueue().filter(r => r.status === 'pending');

  if (opts.minScore != null) {
    pending = pending.filter(r => parseScoreNumber(r.score) >= opts.minScore);
  }

  // Legacy rows with no stored URL whose report file was deleted can never be
  // opened — partition them out so the batch goes straight to actionable jobs
  // instead of printing a multi-line error for every dead entry.
  const dead = pending.filter(r => !resolveQueueUrl(r));
  let actionable = pending.filter(r => resolveQueueUrl(r));

  if (opts.limit != null) {
    actionable = actionable.slice(0, opts.limit);
  }

  if (dead.length) {
    console.log(dim(`Skipping ${dead.length} unusable item(s) (no URL, report missing). Clear them with: career-ops review prune`));
  }

  if (actionable.length === 0) {
    console.log(yellow('No actionable pending items to apply.'));
    return 0;
  }

  const pending2 = actionable;
  console.log(bold(`\n▶ Batch apply: ${pending2.length} pending item(s)`)
    + (opts.minScore != null ? dim(`  (score ≥ ${opts.minScore})`) : ''));
  console.log(yellow('Safety: the assistant fills safe fields and uploads your CV, but never clicks final submit.'));
  console.log(dim('For each job: review/submit in the browser, then press Ctrl+C to advance to the next.'));
  console.log(dim('Press Ctrl+C twice within ~1.5s to abort the whole batch.\n'));

  // The apply-assistant child handles its own Ctrl+C (closes the browser and
  // exits). Keep this parent process alive on that signal so the batch can
  // advance; a quick double Ctrl+C aborts the remaining items.
  let lastSigint = 0;
  let aborted = false;
  const onSigint = () => {
    const now = Date.now();
    if (now - lastSigint < 1500) aborted = true;
    lastSigint = now;
  };
  process.on('SIGINT', onSigint);

  let opened = 0;
  let skipped = 0;
  try {
    for (let i = 0; i < pending2.length; i++) {
      if (aborted) { console.log(yellow('\n■ Batch aborted by user.')); break; }
      const row = pending2[i];
      console.log(cyan(`\n[${i + 1}/${pending2.length}] ${row.id}  ${row.score}  ${row.company} — ${row.role}`));
      const code = await cmdApprove(row.id, { browser: true, confirmSubmit: opts.confirmSubmit !== false, forwardArgs: opts.forwardArgs || [] });
      if (code === 0) opened++;
      else { skipped++; console.log(yellow(`↷ skipped ${row.id} (see message above)`)); }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  console.log(bold(`\n✔ Batch complete: ${opened} opened, ${skipped} skipped of ${pending2.length}.`));
  console.log(dim('Jobs you confirmed submitted were marked automatically. To mark others: career-ops review submitted <id>'));
  return 0;
}

function cmdPrune(opts = {}) {
  const rows = readQueue();
  const dead = rows.filter(r => r.status === 'pending' && !resolveQueueUrl(r));
  if (dead.length === 0) {
    console.log(green('Queue is clean — no unusable pending entries.'));
    return 0;
  }
  console.log(bold(`Found ${dead.length} unusable pending entr${dead.length === 1 ? 'y' : 'ies'} (no URL, report file missing):`));
  for (const r of dead) console.log(dim(`  ${r.id}  ${r.score}  ${r.company} — ${r.role}`));
  if (opts.dryRun) {
    console.log(dim('\n(dry run — nothing removed. Re-run without --dry-run to remove them.)'));
    return 0;
  }
  const deadIds = new Set(dead.map(r => r.id));
  writeQueue(rows.filter(r => !deadIds.has(r.id)));
  console.log(green(`\n✔ Removed ${dead.length} unusable entr${dead.length === 1 ? 'y' : 'ies'} from the queue.`));
  console.log(dim('They will be re-queued automatically if the pipeline re-evaluates those jobs.'));
  return 0;
}

// Transition a queue row to `submitted` and flip its tracker row to Applied.
// Returns { ok, found, trackerUpdated } so callers can report precisely.
function markSubmitted(id, note) {
  const rows = readQueue();
  const i = rows.findIndex(r => r.id === id);
  if (i === -1) return { ok: false, found: false, trackerUpdated: false };
  const row = rows[i];
  if (row.status !== 'submitted') {
    rows[i] = { ...row, status: 'submitted' };
    writeQueue(rows);
  }
  const trackerUpdated = setTrackerStatus(row.report, 'Applied', note || `Submitted ${new Date().toISOString().slice(0, 10)}`);
  return { ok: true, found: true, trackerUpdated, row };
}

function cmdSubmitted(id) {
  const res = markSubmitted(id, `Submitted manually ${new Date().toISOString().slice(0, 10)}`);
  if (!res.found) { console.error(`No queue entry: ${id}`); return 1; }
  console.log(green(`✔ Marked ${id} as submitted`) + (res.trackerUpdated ? green('  · tracker updated → Applied') : dim('  · tracker row not found')));
  return res.trackerUpdated ? 0 : 1;
}

function cmdReject(id, reason) {
  const rows = readQueue();
  const i = rows.findIndex(r => r.id === id);
  if (i === -1) { console.error(`No queue entry: ${id}`); return 1; }
  const row = rows[i];
  rows[i] = { ...row, status: 'rejected' };
  writeQueue(rows);
  const note = reason ? `SKIP: ${reason}` : 'SKIP';
  const updated = setTrackerStatus(row.report, 'SKIP', note);
  console.log(red(`✘ Rejected ${id}`) + (updated ? green('  · tracker updated → SKIP') : dim('  · tracker row not found')));
  return 0;
}

function cmdEnqueue(reportNum) {
  // Retroactively queue an already-merged tracker row.
  if (!existsSync(PATHS.apps)) { console.error('applications.md not found'); return 1; }
  const padded = String(reportNum).padStart(3, '0');
  const lines = readFileSync(PATHS.apps, 'utf-8').split('\n');
  const line = lines.find(l => l.startsWith('|') && new RegExp(`\\[${padded}\\]\\(reports/`).test(l));
  if (!line) { console.error(`No tracker row references report ${padded}`); return 1; }
  const cells = line.split('|').map(s => s.trim());
  // num | date | company | role | score | status | pdf | report | notes
  const entry = {
    company: cells[3] || 'Unknown',
    role:    cells[4] || 'Unknown',
    score:   cells[5] || '?/5',
    report:  cells[8] || '-',
    url:     '-',
  };
  return enqueueIfQualified({ ...entry, threshold: 0 })
    .then(res => {
      if (res) console.log(green(`✔ Enqueued ${res.id}: ${res.company} — ${res.role} (${res.score})`));
      else console.log(yellow('Already queued or no-op.'));
      return 0;
    });
}

// ── Help ────────────────────────────────────────────────────────

function printHelp() {
  console.log(`career-ops review — manage the submit-review queue

USAGE
  career-ops review list      [--pending|--approved|--rejected|--all]
  career-ops review show      <id>
  career-ops review approve   <id> [--browser] [--no-confirm] [apply flags]
  career-ops review apply-all  [--min-score N] [--limit N] [--no-confirm] [apply flags]
  career-ops review prune     [--dry-run]
  career-ops review submitted <id>
  career-ops review reject    <id> [--reason "..."]
  career-ops review enqueue   <reportNum>

The pipeline enqueues evaluations scoring ≥ review.apply_threshold
(default 4.0) into data/review-queue.md. Nothing is ever submitted
on your behalf — \`approve\` launches apply-assistant.mjs which only
DRAFTS answers. Use \`--browser\` to fill safe fields and stop before submit.
Browser apply flags such as \`--llm-answer-tokens 300\` are forwarded.
After you close the browser, \`--browser\` runs ask "Did you submit?" and,
if you confirm, flip the queue row to \`submitted\` and the tracker to Applied
automatically. Pass \`--no-confirm\` to skip that prompt, then mark it later
with \`career-ops review submitted <id>\`.

\`apply-all\` walks every pending item in turn, opening the browser
form-filler for each (newest queue order). Review/submit each one, then
press Ctrl+C to advance to the next; press Ctrl+C twice quickly to abort.
Filter with \`--min-score 4.5\` or cap the run with \`--limit 10\`.
Items with no URL and a missing report are skipped automatically.

\`prune\` removes pending entries that can never be applied (no stored URL
and their report file is gone — typically legacy rows). Use \`--dry-run\`
to preview first.
`);
}

// ── Entry point ─────────────────────────────────────────────────

export default async function main(argv = []) {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return 0;
  }

  ensureQueueFile();

  if (sub === 'list') {
    const flag = rest.find(a => a.startsWith('--'));
    const filter = flag === '--all'      ? 'all'
                 : flag === '--approved' ? 'approved'
                 : flag === '--rejected' ? 'rejected'
                 : 'pending';
    return cmdList(filter);
  }

  if (sub === 'show')     return cmdShow(rest[0]);
  if (sub === 'approve')  return cmdApprove(rest[0], {
    browser: rest.includes('--browser'),
    confirmSubmit: !rest.includes('--no-confirm'),
    forwardArgs: rest.slice(1).filter(a => a !== '--browser' && a !== '--no-confirm'),
  });
  if (sub === 'apply-all' || sub === 'apply-pending') {
    const numFlag = (name) => {
      const i = rest.indexOf(name);
      if (i === -1) return null;
      const v = parseFloat(rest[i + 1]);
      return Number.isFinite(v) ? v : null;
    };
    const minScore = numFlag('--min-score');
    const limit = numFlag('--limit');
    const consumed = new Set(['--min-score', '--limit']);
    const forwardArgs = rest.filter((a, i) => {
      if (consumed.has(a)) return false;
      if (consumed.has(rest[i - 1])) return false;
      return a !== '--browser' && a !== '--no-confirm';
    });
    return cmdApplyAll({ minScore, limit, confirmSubmit: !rest.includes('--no-confirm'), forwardArgs });
  }
  if (sub === 'prune')    return cmdPrune({ dryRun: rest.includes('--dry-run') });
  if (sub === 'submitted') return cmdSubmitted(rest[0]);
  if (sub === 'reject') {
    const id = rest[0];
    const ri = rest.indexOf('--reason');
    const reason = ri !== -1 ? rest[ri + 1] : null;
    return cmdReject(id, reason);
  }
  if (sub === 'enqueue')  return cmdEnqueue(rest[0]);

  console.error(`Unknown review subcommand: ${sub}`);
  printHelp();
  return 2;
}
