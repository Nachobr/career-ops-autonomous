#!/usr/bin/env node

/**
 * career-ops — unified CLI entrypoint
 *
 * Single command that dispatches to every existing .mjs script and to the
 * higher-level `run` orchestrator in commands/run.mjs.
 *
 * Implements Task 1 + Task 3 of docs/AUTONOMOUS_CLI_TODO.md.
 *
 * Usage:
 *   career-ops <subcommand> [args...]
 *   career-ops --help
 *   career-ops --version
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

if (!process.env.CAREER_OPS_RUN_ID) {
  process.env.CAREER_OPS_RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 10)}`;
}

// Load .env early so subcommands and child processes see Colab / API keys.
// dotenv is an existing dependency. It does NOT overwrite existing env vars,
// which means CLI flags / shell exports always win.
try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), quiet: true });
} catch { /* dotenv not installed — proceed without */ }

// ── ANSI helpers ────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const bold = (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s;
const dim  = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;
const cyan = (s) => isTTY ? `\x1b[36m${s}\x1b[0m` : s;
const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;

// ── Subcommand table ────────────────────────────────────────────
// Each entry: { script: relative path, desc: one-line description }
// Special entries: { internal: 'run' } resolved below.
const COMMANDS = {
  scan:       { script: 'scan.mjs',              desc: 'Scan portals for new offers (zero-token API hits).' },
  pipeline:   { script: 'batch-pipeline.mjs',    desc: 'Process pending URLs from data/pipeline.md.' },
  eval:       { script: 'local-eval.mjs',        desc: 'Evaluate a single JD (local LLM). Use --file or pipe stdin.' },
  'gemini-eval': { script: 'gemini-eval.mjs',    desc: 'Evaluate a single JD using Google Gemini API.' },
  pdf:        { script: 'generate-pdf.mjs',      desc: 'Generate ATS-optimized CV PDF from cv.md.' },
  latex:      { script: 'generate-latex.mjs',    desc: 'Generate CV as LaTeX/Overleaf .tex.' },
  liveness:   { script: 'check-liveness.mjs',    desc: 'Check whether tracked job postings are still live.' },
  merge:      { script: 'merge-tracker.mjs',     desc: 'Merge batch/tracker-additions/*.tsv into applications.md.' },
  verify:     { script: 'verify-pipeline.mjs',   desc: 'Health-check the tracker (URL, legitimacy, status integrity).' },
  normalize:  { script: 'normalize-statuses.mjs',desc: 'Normalize tracker status column to canonical states.' },
  dedup:      { script: 'dedup-tracker.mjs',     desc: 'De-duplicate tracker entries by company+role.' },
  doctor:     { script: 'doctor.mjs',            desc: 'Validate setup and prerequisites.' },
  patterns:   { script: 'analyze-patterns.mjs',  desc: 'Analyze rejection patterns (JSON output).' },
  followup:   { script: 'followup-cadence.mjs',  desc: 'Compute follow-up cadence (JSON output).' },
  apply:      { script: 'apply-assistant.mjs',   desc: 'Live application assistant (form-filling helper).' },
  tracker:    { internal: 'tracker',             desc: 'Print application tracker summary.' },
  'sync-check': { script: 'cv-sync-check.mjs',   desc: 'Check cv.md vs derived CVs are in sync.' },
  update:     { script: 'update-system.mjs',     desc: 'Update career-ops: check | apply | rollback | dismiss.' },
  test:       { script: 'test-all.mjs',          desc: 'Run the full test suite.' },
  run:        { internal: 'run',                  desc: 'End-to-end autonomous pipeline (scan → eval → PDF → tracker).' },
  schedule:   { internal: 'schedule',             desc: 'Schedule recurring career-ops runs.' },
  runner:     { script: 'modes/runner.mjs',       desc: 'Headless executor for modes/*.md prompts (LLM-agnostic).' },
  review:     { internal: 'review',                desc: 'Submit-review queue (list | show | approve | reject | enqueue).' },
  'apply-targets': { internal: 'apply-targets',     desc: 'Open reachable targets from data/apply-targets.md (next | list).' },
  login:      { internal: 'login',                 desc: 'Configure LLM provider credentials in .env.' },
  colab:      { internal: 'colab',                desc: 'Manage the Google Colab LLM backend (status | test | set | clear).' },
};

const ALIASES = {
  evaluate: 'eval',
  followups: 'followup',
  'follow-up': 'followup',
  health: 'doctor',
  selftest: 'test',
};

// ── Version ─────────────────────────────────────────────────────
function readVersion() {
  const vfile = join(ROOT, 'VERSION');
  if (existsSync(vfile)) {
    return readFileSync(vfile, 'utf-8').trim();
  }
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Help ────────────────────────────────────────────────────────
function printHelp() {
  const v = readVersion();
  console.log(`${bold('career-ops')} ${dim('v' + v)} — AI job-search pipeline

${bold('Usage:')}
  career-ops <command> [args...]
  career-ops --help | -h
  career-ops --version | -V

${bold('Commands:')}`);

  const width = Math.max(...Object.keys(COMMANDS).map(k => k.length));
  for (const [name, meta] of Object.entries(COMMANDS)) {
    console.log(`  ${cyan(name.padEnd(width))}  ${meta.desc}`);
  }

  console.log(`
${bold('Examples:')}
  career-ops doctor                       # validate setup
  career-ops scan                         # refresh inbox from portals
  career-ops eval --file ./jds/role.txt   # evaluate one JD
  career-ops run --dry-run                # preview end-to-end pipeline
  career-ops run --max-jobs 3             # full pipeline, cap evals at 3

${dim('All extra args after the subcommand are forwarded to the underlying script.')}
${dim('Aliases: ' + Object.entries(ALIASES).map(([a,t]) => `${a} → ${t}`).join(', '))}
`);
}

function printHelpFor(name) {
  const meta = COMMANDS[name];
  if (!meta) {
    console.error(`Unknown command: ${name}`);
    process.exit(2);
  }
  console.log(`${bold('career-ops ' + name)} — ${meta.desc}\n`);
  if (meta.internal === 'run') {
    console.log(`Flags:
  --dry-run                Print the pipeline plan and exit.
  --only=step,step,...     Run only the named steps (comma-separated).
  --skip=step,step,...     Skip the named steps.
  --max-jobs N             Cap the number of evals in the pipeline step.
  --engine=runner|claude   Choose evaluation engine (default: runner).
  --auto-apply             After a successful run, open browser form-filler
                           for newly queued high-fit jobs. Never submits.
  --auto-apply-limit N     Max browser flows to open (default: 1).
  --llm-base URL           Override LOCAL_LLM_BASE_URL (e.g. Colab ngrok URL).
  --llm-model NAME         Override LOCAL_LLM_MODEL.
  --llm-key TOKEN          Override LOCAL_LLM_API_KEY.
  --no-notify              Suppress final summary notification.
  --no-alerts              Skip outbound notifications (audit log still written).

Steps (default order):
  doctor, scan, liveness, pipeline, pdf, merge, normalize,
  dedup, verify, followup, summary
`);
    return;
  }
  if (meta.internal === 'colab') {
    console.log(`Subcommands:
  status   Show current LOCAL_LLM_* configuration.
  test     Ping the configured endpoint and list served models.
  set      Write --base / --model / --key into .env.
  clear    Remove LOCAL_LLM_* keys from .env.

Examples:
  career-ops colab set --base https://xxxx.ngrok-free.app --model Qwen/Qwen2.5-7B-Instruct
  career-ops colab test
`);
    return;
  }
  if (meta.internal === 'login') {
    console.log(`Subcommands:
  --status                 Show configured providers without printing secrets.
  --provider <name>        Configure gemini, anthropic, or openai.
  --force                  Overwrite an existing key in .env.
  --no-validate            Store key without API validation.

Examples:
  career-ops login --status
  career-ops login --provider gemini
  career-ops login --provider openai --no-validate
`);
    return;
  }
  if (meta.internal === 'tracker') {
    console.log(`Prints a summary of data/applications.md: total rows plus counts by status.

Usage:
  career-ops tracker
`);
    return;
  }
  if (meta.internal === 'schedule') {
    console.log(`Subcommands:
  install --every 3d    Install launchd/systemd recurring run.
  status                Show installed state and latest run log.
  uninstall             Remove launchd/systemd schedule.
  daemon --every 12h    Foreground scheduler for tmux/Docker.

Usage:
  career-ops schedule install --every 3d
  career-ops schedule status
  career-ops schedule uninstall
  career-ops schedule daemon --every 12h
`);
    return;
  }
  console.log(`Forwards all flags to: node ${meta.script}\n`);
  console.log(`Run \`node ${meta.script} --help\` for script-specific flags (if supported).`);
}

function parseTrackerRows(text) {
  return text.split('\n')
    .filter(line => /^\|\s*\d+\s*\|/.test(line))
    .map(line => line.split('|').map(cell => cell.trim()))
    .filter(cells => cells.length >= 9)
    .map(cells => ({
      id: cells[1],
      date: cells[2],
      company: cells[3],
      role: cells[4],
      score: cells[5],
      status: cells[6],
      pdf: cells[7],
      report: cells[8],
      notes: cells[9] || '',
    }));
}

function printTrackerSummary() {
  const appsPath = join(ROOT, 'data', 'applications.md');
  if (!existsSync(appsPath)) {
    console.error('career-ops tracker: data/applications.md not found');
    return 1;
  }

  const rows = parseTrackerRows(readFileSync(appsPath, 'utf-8'));
  const counts = new Map();
  for (const row of rows) {
    const status = row.status || '(blank)';
    counts.set(status, (counts.get(status) || 0) + 1);
  }

  console.log(`${bold('Application tracker')} — ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`);
  console.log('');
  if (counts.size === 0) {
    console.log(dim('(no tracker rows found)'));
    return 0;
  }

  console.log(bold('Status counts'));
  const width = Math.max(...[...counts.keys()].map(s => s.length));
  for (const [status, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${status.padEnd(width)}  ${count}`);
  }

  const latest = rows[rows.length - 1];
  if (latest) {
    console.log('');
    console.log(bold('Latest'));
    console.log(`  #${latest.id} ${latest.company} — ${latest.role} (${latest.score}, ${latest.status})`);
  }
  return 0;
}

// ── Dispatcher ──────────────────────────────────────────────────
function spawnScript(scriptRel, args) {
  const scriptAbs = join(ROOT, scriptRel);
  if (!existsSync(scriptAbs)) {
    console.error(`career-ops: missing script ${scriptRel}`);
    process.exit(127);
  }
  const child = spawn(process.execPath, [scriptAbs, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      CAREER_OPS_CLI: '1',
      CAREER_OPS_VERSION: readVersion(),
      CAREER_OPS_RUN_ID: process.env.CAREER_OPS_RUN_ID,
    },
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`career-ops: ${scriptRel} terminated by signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error(`career-ops: failed to spawn ${scriptRel}: ${err.message}`);
    process.exit(1);
  });
}

async function runInternal(name, args) {
  if (name === 'tracker') {
    process.exit(printTrackerSummary());
  }
  const file = name === 'run' ? 'run.mjs' : `${name}.mjs`;
  const mod = await import(pathToFileURL(join(ROOT, 'commands', file)).href);
  const code = await mod.default(args);
  process.exit(code ?? 0);
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    if (argv[0] === 'help' && argv[1]) return printHelpFor(ALIASES[argv[1]] || argv[1]);
    return printHelp();
  }

  if (argv[0] === '--version' || argv[0] === '-V' || argv[0] === 'version') {
    console.log(readVersion());
    return;
  }

  const raw = argv[0];
  const name = ALIASES[raw] || raw;
  const meta = COMMANDS[name];

  if (!meta) {
    console.error(`career-ops: unknown command '${raw}'.`);
    console.error(`Run \`career-ops --help\` to see all commands.`);
    process.exit(2);
  }

  const rest = argv.slice(1);

  // Per-subcommand help passthrough.
  // For internal commands, prefer the command's own --help (richer); for
  // scripts spawned via spawnScript, fall back to the dispatcher summary.
  if (rest[0] === '--help' || rest[0] === '-h') {
    if (meta.internal && meta.internal !== 'run' && meta.internal !== 'colab') {
      return runInternal(meta.internal, rest);
    }
    return printHelpFor(name);
  }

  if (meta.internal) {
    return runInternal(meta.internal, rest);
  }

  spawnScript(meta.script, rest);
}

main().catch((err) => {
  console.error(`career-ops: ${err?.stack || err}`);
  process.exit(1);
});
