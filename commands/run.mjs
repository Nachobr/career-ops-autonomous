/**
 * commands/run.mjs — end-to-end autonomous pipeline
 *
 * Chains the existing scripts in a sensible order so the user only needs
 * `career-ops run` to perform a complete cycle.
 *
 * Implements Task 3 of docs/AUTONOMOUS_CLI_TODO.md.
 *
 * Exit codes:
 *   0  all required steps succeeded (optional steps may have warned)
 *   1  a required step failed
 *   2  invalid CLI args
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../lib/logger.mjs';
import { notify } from '../lib/notify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const LOCK_FILE = join(ROOT, 'data', '.run.lock');
const REVIEW_QUEUE = join(ROOT, 'data', 'review-queue.md');

// ── ANSI ────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const bold   = (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s;
const dim    = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;
const green  = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red    = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const cyan   = (s) => isTTY ? `\x1b[36m${s}\x1b[0m` : s;

// ── Pipeline definition ─────────────────────────────────────────
// `required: true` → a non-zero exit aborts the run.
// `required: false` → log a warning and continue.
// `optional: true` → only runs when explicitly enabled or the input exists.
const STEPS = [
  {
    name: 'doctor',
    desc: 'Preflight: validate setup',
    script: 'doctor.mjs',
    args: ['--json'],
    required: true,
  },
  {
    name: 'scan',
    desc: 'Scan portals for new offers',
    script: 'scan.mjs',
    required: false,
  },
  {
    name: 'liveness',
    desc: 'Check liveness of tracked URLs (opt-in: --only=liveness with URLs)',
    script: 'check-liveness.mjs',
    required: false,
    optIn: true, // needs URL args, not auto-runnable
  },
  {
    name: 'pipeline',
    desc: 'Evaluate pending JDs from data/pipeline.md',
    script: 'batch-pipeline.mjs',
    required: false,
    forwardMaxJobs: true, // propagates --max-jobs via env CAREER_OPS_MAX_JOBS
  },
  {
    name: 'pdf',
    desc: 'Regenerate ATS-optimized CV PDF (opt-in: needs <input.html> <output.pdf>)',
    script: 'generate-pdf.mjs',
    required: false,
    optIn: true, // takes positional args; meant for per-report invocation
  },
  {
    name: 'merge',
    desc: 'Merge batch/tracker-additions/*.tsv into tracker',
    script: 'merge-tracker.mjs',
    required: false,
    skipIf: () => !hasTrackerAdditions(),
  },
  {
    name: 'normalize',
    desc: 'Normalize tracker statuses',
    script: 'normalize-statuses.mjs',
    required: false,
  },
  {
    name: 'dedup',
    desc: 'De-duplicate tracker entries',
    script: 'dedup-tracker.mjs',
    required: false,
  },
  {
    name: 'verify',
    desc: 'Pipeline integrity health check',
    script: 'verify-pipeline.mjs',
    required: false,
  },
  {
    name: 'followup',
    desc: 'Compute follow-up cadence',
    script: 'followup-cadence.mjs',
    required: false,
    args: ['--json'],
  },
  // `summary` is internal — printed by this orchestrator, not a script.
];

// ── Helpers ─────────────────────────────────────────────────────
function hasTrackerAdditions() {
  const dir = join(ROOT, 'batch', 'tracker-additions');
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((f) => f.endsWith('.tsv'));
  } catch {
    return false;
  }
}

function readReviewQueueRows() {
  if (!existsSync(REVIEW_QUEUE)) return [];
  try {
    const text = readFileSync(REVIEW_QUEUE, 'utf-8');
    return text.split('\n')
      .filter((line) => line.startsWith('| q-'))
      .map((line) => line.split('|').map((cell) => cell.trim()))
      .filter((parts) => parts.length >= 9)
      .map((parts) => ({
        id: parts[1],
        added: parts[2],
        score: parts[3],
        status: parts[4],
        company: parts[5],
        role: parts[6],
        url: parts[7],
        report: parts[8],
      }));
  } catch {
    return [];
  }
}

function diffReviewQueueRows(beforeQueueIds) {
  return readReviewQueueRows().filter((row) => !beforeQueueIds.has(row.id));
}

function renderQueuedRows(rows) {
  return rows.slice(0, 10)
    .map((row) => `- ${row.id} ${row.company} — ${row.role} (${row.score})`)
    .join('\n') || '- none';
}

function renderSummaryTable(results) {
  const header = 'name        status    code  ms';
  const lines = results.map((r) => [
    String(r.name || '').padEnd(10),
    String(r.status || '').padEnd(8),
    String(r.code ?? '').padEnd(4),
    String(r.ms ?? '').padEnd(6),
  ].join('  '));
  return [header, ...lines].join('\n');
}

function parseFollowupDueCount(stdout) {
  try {
    const parsed = JSON.parse(stdout || 'null');
    return Number(parsed?.due_count ?? parsed?.dueCount ?? parsed?.metadata?.due_count ?? parsed?.metadata?.actionable ?? 0) || 0;
  } catch {
    return 0;
  }
}

async function safeNotify(logger, payload) {
  try {
    return await notify(payload);
  } catch (err) {
    logger.warn('notification failed', { event: 'notification_failed', kind: payload?.kind, error: err.message });
    return null;
  }
}

function spawnReviewApproveBrowser(row) {
  return new Promise((resolveP) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(ROOT, 'bin', 'career-ops.mjs'), 'review', 'approve', row.id, '--browser'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code, signal) => {
      const ms = Date.now() - started;
      if (signal) return resolveP({ status: 'failed', code: 1, ms, reason: `signal ${signal}` });
      if (code === 0) return resolveP({ status: 'ok', code: 0, ms });
      return resolveP({ status: 'failed', code: code ?? 1, ms });
    });
    child.on('error', (err) => resolveP({ status: 'failed', code: 1, reason: err.message }));
  });
}

async function runAutoApply(beforeQueueIds, opts) {
  const rows = readReviewQueueRows();
  const candidates = rows.filter((row) => row.status === 'pending' && !beforeQueueIds.has(row.id));
  const selected = opts.autoApplyLimit == null ? candidates : candidates.slice(0, opts.autoApplyLimit);
  const skipped = candidates.length - selected.length;

  if (selected.length === 0) {
    console.log(dim('↷ auto-apply skipped — no newly queued high-fit applications'));
    return { status: 'skipped', code: 0, reason: 'no newly queued applications' };
  }

  console.log(`\n${bold('▶ auto-apply')} ${dim('(review approve --browser)')}`);
  console.log(yellow('Safety: browser assistant fills safe fields and uploads CVs, but never clicks final submit.'));
  if (skipped > 0) {
    console.log(dim(`Opening ${selected.length} of ${candidates.length} new queued item(s). Increase with --auto-apply-limit N.`));
  }

  const started = Date.now();
  const children = [];
  for (const row of selected) {
    console.log(`\n${cyan(row.id)} ${row.score} — ${row.company} — ${row.role}`);
    const result = await spawnReviewApproveBrowser(row);
    children.push({ id: row.id, ...result });
    if (result.status !== 'ok') {
      console.log(yellow(`⚠ auto-apply failed for ${row.id} (exit ${result.code})${result.reason ? ' — ' + result.reason : ''}`));
      return { status: 'failed', code: result.code || 1, ms: Date.now() - started, children };
    }
  }

  console.log(green(`✔ auto-apply browser flow launched for ${selected.length} item(s)`));
  return { status: 'ok', code: 0, ms: Date.now() - started, children, skipped };
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    all: false,
    only: null,    // Set<string> | null
    skip: new Set(),
    maxJobs: null,
    engine: 'runner',
    notify: true,
    noAlerts: false,
    llmBase: null,
    llmModel: null,
    llmKey: null,
    autoApply: false,
    autoApplyLimit: 1,
  };
  const SEP_FLAGS = new Set(['--max-jobs', '--llm-base', '--llm-model', '--llm-key', '--engine', '--only', '--skip', '--auto-apply-limit']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--auto-apply') opts.autoApply = true;
    else if (arg === '--no-notify') opts.notify = false;
    else if (arg === '--no-alerts') opts.noAlerts = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--only=')) {
      opts.only = new Set(arg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean));
    } else if (arg.startsWith('--skip=')) {
      for (const s of arg.slice('--skip='.length).split(',')) {
        if (s.trim()) opts.skip.add(s.trim());
      }
    } else if (arg.startsWith('--max-jobs=')) {
      opts.maxJobs = parseInt(arg.slice('--max-jobs='.length), 10);
    } else if (arg.startsWith('--engine=')) {
      opts.engine = arg.slice('--engine='.length);
    } else if (arg.startsWith('--llm-base=')) {
      opts.llmBase = arg.slice('--llm-base='.length).replace(/\/$/, '');
    } else if (arg.startsWith('--llm-model=')) {
      opts.llmModel = arg.slice('--llm-model='.length);
    } else if (arg.startsWith('--llm-key=')) {
      opts.llmKey = arg.slice('--llm-key='.length);
    } else if (arg.startsWith('--auto-apply-limit=')) {
      opts.autoApplyLimit = parseInt(arg.slice('--auto-apply-limit='.length), 10);
    } else if (SEP_FLAGS.has(arg) && argv[i + 1] != null) {
      const v = argv[++i];
      if (arg === '--max-jobs')  opts.maxJobs = parseInt(v, 10);
      else if (arg === '--llm-base')  opts.llmBase = v.replace(/\/$/, '');
      else if (arg === '--llm-model') opts.llmModel = v;
      else if (arg === '--llm-key')   opts.llmKey = v;
      else if (arg === '--engine')    opts.engine = v;
      else if (arg === '--only')      opts.only = new Set(v.split(',').map(s => s.trim()).filter(Boolean));
      else if (arg === '--skip') { for (const s of v.split(',')) if (s.trim()) opts.skip.add(s.trim()); }
      else if (arg === '--auto-apply-limit') opts.autoApplyLimit = parseInt(v, 10);
    } else if (arg.startsWith('-')) {
      console.error(`career-ops run: unknown flag '${arg}'`);
      opts.invalid = true;
    }
  }
  if (opts.maxJobs !== null && Number.isNaN(opts.maxJobs)) {
    console.error(`career-ops run: --max-jobs must be an integer`);
    opts.invalid = true;
  }
  if (opts.autoApplyLimit !== null && (!Number.isInteger(opts.autoApplyLimit) || opts.autoApplyLimit < 1)) {
    console.error('career-ops run: --auto-apply-limit must be a positive integer');
    opts.invalid = true;
  }
  if (opts.all && opts.maxJobs !== null) {
    console.error('career-ops run: use either --all or --max-jobs, not both');
    opts.invalid = true;
  }
  return opts;
}

function resolveLlmTarget(opts) {
  // Precedence: CLI flag > shell env > .env (already loaded by dotenv)
  const base  = opts.llmBase  || process.env.LOCAL_LLM_BASE_URL || '';
  const model = opts.llmModel || process.env.LOCAL_LLM_MODEL    || '';
  const key   = opts.llmKey   || process.env.LOCAL_LLM_API_KEY  || '';
  const provider = base.includes('ngrok')        ? 'colab/ngrok'
                 : base.includes('groq.com')     ? 'groq'
                 : base.includes('openai.com')   ? 'openai'
                 : base.includes('googleapis')   ? 'gemini'
                 : base.includes('anthropic')    ? 'anthropic'
                 : base.startsWith('http://127.0.0.1') || base.startsWith('http://localhost') ? 'local'
                 : base ? 'custom' : 'unconfigured';
  return { base, model, key, provider };
}

function selectSteps(opts) {
  return STEPS.filter((s) => {
    if (opts.only) return opts.only.has(s.name);     // --only is exhaustive: include even opt-in steps
    if (opts.skip.has(s.name)) return false;
    if (s.optIn) return false;                       // opt-in steps excluded from default plan
    return true;
  });
}

function runStep(step, opts) {
  return new Promise((resolveP) => {
    if (typeof step.skipIf === 'function' && step.skipIf()) {
      return resolveP({ status: 'skipped', reason: 'no input', code: 0 });
    }
    const scriptAbs = join(ROOT, step.script);
    if (!existsSync(scriptAbs)) {
      return resolveP({ status: 'missing', code: 127, reason: `${step.script} not found` });
    }
    const args = step.args ? [...step.args] : [];
    const env = { ...process.env, CAREER_OPS_RUN: '1', CAREER_OPS_RUN_LOCK_PID: String(process.pid) };
    if (step.forwardMaxJobs && opts.maxJobs != null) {
      env.CAREER_OPS_MAX_JOBS = String(opts.maxJobs);
    }
    if (step.name === 'pipeline') {
      env.CAREER_OPS_ENGINE = opts.engine;
    }
    // LLM overrides — apply to every step that may spawn local-eval.mjs
    // (pipeline, plus future runner.mjs). Child reads via dotenv/config or env.
    if (opts.llmBase)  env.LOCAL_LLM_BASE_URL = opts.llmBase;
    if (opts.llmModel) env.LOCAL_LLM_MODEL    = opts.llmModel;
    if (opts.llmKey)   env.LOCAL_LLM_API_KEY  = opts.llmKey;

    const started = Date.now();
    let stdout = '';
    const captureStdout = step.name === 'followup';
    const child = spawn(process.execPath, [scriptAbs, ...args], {
      cwd: ROOT,
      stdio: ['inherit', captureStdout ? 'pipe' : 'inherit', 'inherit'],
      env,
    });
    if (captureStdout && child.stdout) {
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        process.stdout.write(text);
      });
    }
    child.on('exit', (code, signal) => {
      const ms = Date.now() - started;
      if (signal) {
        return resolveP({ status: 'failed', code: 1, ms, reason: `signal ${signal}`, stdout });
      }
      if (code === 0) return resolveP({ status: 'ok', code: 0, ms, stdout });
      return resolveP({ status: 'failed', code: code ?? 1, ms, stdout });
    });
    child.on('error', (err) => {
      resolveP({ status: 'failed', code: 1, reason: err.message, stdout });
    });
  });
}

function newRunId() {
  return process.env.CAREER_OPS_RUN_ID || `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 10)}`;
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function acquireRunLock(runId) {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  if (existsSync(LOCK_FILE)) {
    let lock = null;
    try { lock = JSON.parse(readFileSync(LOCK_FILE, 'utf-8')); } catch {}
    if (lock?.pid && pidAlive(lock.pid)) {
      return { ok: false, reason: `another career-ops run is active (pid ${lock.pid}, started ${lock.startedAt || 'unknown'})` };
    }
    try { unlinkSync(LOCK_FILE); } catch {}
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() }, null, 2), 'utf-8');
  return { ok: true };
}

function releaseRunLock() {
  if (!existsSync(LOCK_FILE)) return;
  try {
    const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
    if (lock.pid && lock.pid !== process.pid) return;
  } catch {}
  try { unlinkSync(LOCK_FILE); } catch {}
}

function printHelp() {
  console.log(`${bold('career-ops run')} — end-to-end autonomous pipeline

${bold('Usage:')}
  career-ops run [flags]

${bold('Flags:')}
  --dry-run                Print the planned steps and exit.
  --only=a,b,c             Run only the listed steps.
  --skip=a,b,c             Skip the listed steps.
  --max-jobs N             Cap pipeline evaluations (passed to batch-pipeline.mjs
                           via CAREER_OPS_MAX_JOBS env var).
  --all                    Intentionally run the full pending queue. Without this,
                           pipeline is capped at CAREER_OPS_DEFAULT_MAX_JOBS or 3.
  --auto-apply             After a successful run, auto-approve newly queued
                           high-fit jobs and open the browser form-filler.
                           It never clicks final submit.
  --auto-apply-limit N     Max new queued jobs to open with --auto-apply
                           (default: 1; each browser waits for your review).
  --engine=runner|claude   Evaluation engine for the pipeline step (default: runner).
                           Passed via CAREER_OPS_ENGINE env var.
  --no-notify              Suppress final summary block.
  --no-alerts              Skip outbound notifications (audit log still written).
  -h, --help               Show this help.

${bold('Default step order:')}
  ${STEPS.map(s => s.name).join(' → ')} → summary

${bold('Examples:')}
  career-ops run --dry-run
  career-ops run --max-jobs 3
  career-ops run --max-jobs 1 --auto-apply
  career-ops run --only=scan,liveness
  career-ops run --skip=pdf,liveness
`);
}

// ── Entry point ─────────────────────────────────────────────────
export default async function run(argv) {
  const opts = parseArgs(argv || []);
  if (opts.help) { printHelp(); return 0; }
  if (opts.invalid) return 2;

  const steps = selectSteps(opts);
  if (steps.length === 0) {
    console.error('career-ops run: no steps selected (check --only/--skip).');
    return 2;
  }

  const runId = newRunId();
  process.env.CAREER_OPS_RUN_ID = runId;
  const startedAt = new Date().toISOString();
  const logger = createLogger({ runId, cmd: 'run' });
  const llm = resolveLlmTarget(opts);
  const beforeQueueIds = new Set(readReviewQueueRows().map((row) => row.id));
  const runsPipeline = !opts.only || opts.only.has('pipeline');
  const skipsPipeline = opts.skip.has('pipeline');
  if (!opts.all && opts.maxJobs == null && runsPipeline && !skipsPipeline) {
    opts.maxJobs = parseInt(process.env.CAREER_OPS_DEFAULT_MAX_JOBS || '3', 10);
    if (!Number.isInteger(opts.maxJobs) || opts.maxJobs <= 0) opts.maxJobs = 3;
  }

  console.log(`\n${bold('career-ops run')} ${dim('id=' + runId)}`);
  console.log(dim(`engine=${opts.engine} max-jobs=${opts.maxJobs ?? '∞'} dry-run=${opts.dryRun}`));
  if (llm.base) {
    console.log(dim(`llm=${llm.provider}  base=${llm.base}  model=${llm.model || '(default)'}`));
  } else {
    if (runsPipeline && !skipsPipeline) {
      console.log(yellow('llm=unconfigured — pipeline step needs LOCAL_LLM_BASE_URL.'));
      console.log(dim('  Run `career-ops colab set --base <url> --model <model>` (Colab),'));
      console.log(dim('  or `--llm-base ... --llm-model ...` flags, or skip with `--skip=pipeline`.'));
    }
  }
  console.log('');

  // Plan / dry-run
  console.log(bold('Plan:'));
  if (runsPipeline && !skipsPipeline && !opts.all) {
    console.log(yellow(`Safety cap active: will evaluate at most ${opts.maxJobs} job(s). Use --all to override.`));
  }
  if (opts.autoApply) {
    console.log(yellow(`Auto-apply active: after success, open browser for up to ${opts.autoApplyLimit} newly queued high-fit job(s). Final submit remains manual.`));
  }
  for (const s of steps) {
    const tag = s.required ? red('required') : dim('optional');
    console.log(`  ${cyan(s.name.padEnd(10))} ${s.desc} ${dim('[' + s.script + ']')} ${tag}`);
  }
  console.log('');

  if (opts.dryRun) {
    logger.event('run_started', { status: 'dry-run', steps: steps.map((s) => s.name), startedAt });
    logger.event('run_finished', { status: 'dry-run', stepCount: 0, startedAt, endedAt: new Date().toISOString() });
    if (!opts.noAlerts) {
      await safeNotify(logger, {
        kind: 'run_dryrun',
        severity: 'info',
        title: 'career-ops run dry-run',
        body: `Planned steps: ${steps.map((s) => s.name).join(', ')}\nrunId: ${runId}\nlog: ${logger.file}`,
        meta: { runId, steps: steps.map((s) => s.name), log: logger.file },
      });
    }
    console.log(yellow('Dry run — no steps executed.'));
    console.log(dim(`log: ${logger.file}`));
    return 0;
  }

  const lock = acquireRunLock(runId);
  if (!lock.ok) {
    logger.error('run lock unavailable', { event: 'run_finished', status: 'failed', error: lock.reason, stepCount: 0, startedAt, endedAt: new Date().toISOString() });
    console.error(`career-ops run: ${lock.reason}`);
    return 1;
  }

  logger.event('run_started', { status: 'started', steps: steps.map((s) => s.name), startedAt });

  // Execute
  const results = [];
  let aborted = false;
  let abortReason = null;
  let abortStep = null;
  let followupsDue = 0;
  let followupOutput = '';

  try {
    for (const step of steps) {
      process.stdout.write(`\n${bold('▶ ' + step.name)} ${dim('(' + step.script + ')')}\n`);
      logger.event('step_started', { step: step.name, script: step.script, required: !!step.required });
      const result = await runStep(step, opts);
      results.push({ name: step.name, script: step.script, ...result });
      const eventMeta = { step: step.name, script: step.script, status: result.status, code: result.code, ms: result.ms, reason: result.reason };

      if (result.status === 'ok') {
        logger.event('step_finished', eventMeta);
        console.log(green(`✔ ${step.name} ok ${dim('(' + result.ms + 'ms)')}`));
      } else if (result.status === 'skipped') {
        logger.event('step_finished', eventMeta);
        console.log(dim(`↷ ${step.name} skipped — ${result.reason || ''}`));
      } else if (result.status === 'missing') {
        const msg = `${step.name} missing — ${result.reason}`;
        if (step.required) {
          logger.error(msg, { ...eventMeta, event: 'step_failed' });
          console.log(red(`✘ ${msg}`));
          aborted = true; abortReason = msg; abortStep = step.name; break;
        }
        logger.warn(msg, { ...eventMeta, event: 'step_failed' });
        console.log(yellow(`⚠ ${msg} (optional, continuing)`));
      } else {
        const msg = `${step.name} failed (exit ${result.code})${result.reason ? ' — ' + result.reason : ''}`;
        if (step.required) {
          logger.error(msg, { ...eventMeta, event: 'step_failed' });
          console.log(red(`✘ ${msg}`));
          aborted = true; abortReason = msg; abortStep = step.name; break;
        }
        logger.warn(msg, { ...eventMeta, event: 'step_failed' });
        console.log(yellow(`⚠ ${msg} (optional, continuing)`));
      }

      if (step.name === 'followup' && result.status === 'ok') {
        followupOutput = result.stdout || '';
        followupsDue = parseFollowupDueCount(followupOutput);
        if (followupsDue > 0 && !opts.noAlerts) {
          await safeNotify(logger, {
            kind: 'followups_due',
            severity: 'info',
            title: `${followupsDue} follow-up(s) due today`,
            body: (followupOutput || '').split('\n').slice(0, 5).join('\n'),
            meta: { runId, dueCount: followupsDue, log: logger.file },
          });
        }
      }
    }

    if (!aborted && opts.autoApply) {
      const autoApplyResult = await runAutoApply(beforeQueueIds, opts);
      results.push({ name: 'auto-apply', script: 'commands/review.mjs', ...autoApplyResult });
      if (autoApplyResult.status === 'failed') {
        console.log(yellow(`⚠ auto-apply failed (exit ${autoApplyResult.code}) (optional, continuing)`));
      }
    }

    const newQueuedRows = diffReviewQueueRows(beforeQueueIds);
    if (!aborted && newQueuedRows.length > 0 && !opts.noAlerts) {
      await safeNotify(logger, {
        kind: 'review_enqueued',
        severity: 'info',
        title: `${newQueuedRows.length} new high-fit job(s) queued for review`,
        body: renderQueuedRows(newQueuedRows),
        meta: { runId, queueIds: newQueuedRows.map((row) => row.id), log: logger.file },
      });
    }

    // Summary
    if (opts.notify) {
      console.log(`\n${bold('Summary')}`);
      const cols = ['name', 'status', 'code', 'ms'];
      const w = { name: 10, status: 8, code: 4, ms: 6 };
      console.log(dim(cols.map(c => c.padEnd(w[c])).join('  ')));
      for (const r of results) {
        const color = r.status === 'ok' ? green : r.status === 'skipped' ? dim : r.status === 'failed' ? red : yellow;
        console.log(color([
          r.name.padEnd(w.name),
          r.status.padEnd(w.status),
          String(r.code ?? '').padEnd(w.code),
          String(r.ms ?? '').padEnd(w.ms),
        ].join('  ')));
      }
      if (aborted) {
        console.log(red(`\n✘ Aborted: ${abortReason}`));
      } else {
        console.log(green(`\n✔ Run complete.`));
      }
    }

    logger.event('run_finished', {
      status: aborted ? 'failed' : 'ok',
      startedAt,
      endedAt: new Date().toISOString(),
      aborted,
      abortReason,
      stepCount: results.length,
      llm: { provider: llm.provider, base: llm.base, model: llm.model, hasKey: !!llm.key },
    });

    if (!opts.noAlerts) {
      if (aborted) {
        await safeNotify(logger, {
          kind: 'run_failed',
          severity: 'error',
          title: `career-ops run failed: ${abortStep || 'unknown step'}`,
          body: `Reason: ${abortReason}\nrunId: ${runId}\nlog: ${logger.file}`,
          meta: { runId, step: abortStep, abortReason, log: logger.file },
        });
      } else if (newQueuedRows.length > 0 || followupsDue > 0) {
        await safeNotify(logger, {
          kind: 'run_completed',
          severity: 'info',
          title: `career-ops run ok — ${newQueuedRows.length} new high-fit, ${followupsDue} follow-ups`,
          body: renderSummaryTable(results),
          meta: { runId, newHighFit: newQueuedRows.length, followupsDue, log: logger.file },
        });
      }
    }
    console.log(dim(`log: ${logger.file}`));

    return aborted ? 1 : 0;
  } finally {
    releaseRunLock();
  }
}
