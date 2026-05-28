#!/usr/bin/env node

/**
 * commands/schedule.mjs — recurring career-ops run scheduler
 *
 * Implements Task 4 of docs/AUTONOMOUS_CLI_TODO.md.
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, platform } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../lib/logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BIN = join(ROOT, 'bin', 'career-ops.mjs');
const LOG_DIR = join(ROOT, 'data', 'logs');
const LABEL = 'io.santifer.career-ops';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const SYSTEMD_DIR = join(homedir(), '.config', 'systemd', 'user');
const SERVICE_PATH = join(SYSTEMD_DIR, 'career-ops.service');
const TIMER_PATH = join(SYSTEMD_DIR, 'career-ops.timer');

const isTTY = process.stdout.isTTY;
const bold = (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s;
const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;
const green = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;

export function parseCadence(input) {
  const m = String(input || '').trim().match(/^(\d+)([mhdw])$/i);
  if (!m) throw new Error('cadence must look like 30m, 12h, 3d, or 1w');
  const n = parseInt(m[1], 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error('cadence number must be positive');
  const unit = m[2].toLowerCase();
  const multipliers = { m: 60, h: 3600, d: 86400, w: 604800 };
  return { input: `${n}${unit}`, seconds: n * multipliers[unit], ms: n * multipliers[unit] * 1000 };
}

function printHelp() {
  console.log(`${bold('career-ops schedule')} — recurring autonomous runs

${bold('Usage:')}
  career-ops schedule install --every 3d [--max-jobs N]
  career-ops schedule status
  career-ops schedule uninstall
  career-ops schedule daemon --every 12h [--max-jobs N]

${bold('Flags:')}
  --every <cadence>   Cadence: 30m, 12h, 3d, 1w.
  --max-jobs N        Forwarded to career-ops run.
  --dry-run           Print files/commands without installing.
  -h, --help          Show this help.
`);
}

function parseArgs(argv) {
  const first = argv[0] || 'help';
  const opts = { cmd: (first === '--help' || first === '-h') ? 'help' : first, every: null, maxJobs: null, dryRun: false, help: first === '--help' || first === '-h' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--every' && argv[i + 1]) opts.every = argv[++i];
    else if (a.startsWith('--every=')) opts.every = a.slice('--every='.length);
    else if (a === '--max-jobs' && argv[i + 1]) opts.maxJobs = parseInt(argv[++i], 10);
    else if (a.startsWith('--max-jobs=')) opts.maxJobs = parseInt(a.slice('--max-jobs='.length), 10);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.maxJobs !== null && !Number.isInteger(opts.maxJobs)) throw new Error('--max-jobs must be an integer');
  return opts;
}

function runArgs(opts = {}) {
  const args = [BIN, 'run'];
  if (opts.maxJobs != null) args.push('--max-jobs', String(opts.maxJobs));
  return args;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function renderLaunchdPlist({ cadence, maxJobs = null } = {}) {
  const args = [process.execPath, ...runArgs({ maxJobs })];
  const argXml = args.map(a => `    <string>${escapeXml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(ROOT)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>StartInterval</key>
  <integer>${cadence.seconds}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(LOG_DIR, 'schedule.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(LOG_DIR, 'schedule.err.log'))}</string>
</dict>
</plist>
`;
}

export function renderSystemdService({ maxJobs = null } = {}) {
  const cmd = [process.execPath, ...runArgs({ maxJobs })].map(shellQuote).join(' ');
  return `[Unit]
Description=career-ops autonomous run

[Service]
Type=oneshot
WorkingDirectory=${ROOT}
ExecStart=${cmd}
`;
}

export function renderSystemdTimer({ cadence } = {}) {
  return `[Unit]
Description=Run career-ops every ${cadence.input}

[Timer]
OnBootSec=5m
OnUnitActiveSec=${cadence.seconds}s
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function escapeXml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function ensureDirs() {
  mkdirSync(LOG_DIR, { recursive: true });
}

function uid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function spawnQuiet(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function installMac(opts, cadence) {
  const plist = renderLaunchdPlist({ cadence, maxJobs: opts.maxJobs });
  if (opts.dryRun) {
    console.log(plist);
    console.log(dim(`Would write ${PLIST_PATH}`));
    return 0;
  }
  ensureDirs();
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, plist, 'utf-8');
  const domain = uid() == null ? null : `gui/${uid()}`;
  if (domain) spawnQuiet('launchctl', ['bootout', domain, PLIST_PATH]);
  const loaded = domain
    ? spawnQuiet('launchctl', ['bootstrap', domain, PLIST_PATH])
    : spawnQuiet('launchctl', ['load', PLIST_PATH]);
  if (loaded.status !== 0) {
    const fallback = spawnQuiet('launchctl', ['load', PLIST_PATH]);
    if (fallback.status !== 0) {
      console.log(yellow(`Wrote ${PLIST_PATH}, but launchctl load failed.`));
      console.log(dim((loaded.stderr || fallback.stderr || '').trim()));
      return 1;
    }
  }
  console.log(green(`Installed launchd agent: ${PLIST_PATH}`));
  console.log(`Runs every ${cadence.input}. Check with: launchctl list | grep career-ops`);
  return 0;
}

function installLinux(opts, cadence) {
  const service = renderSystemdService({ maxJobs: opts.maxJobs });
  const timer = renderSystemdTimer({ cadence });
  if (opts.dryRun) {
    console.log(`# ${SERVICE_PATH}\n${service}`);
    console.log(`# ${TIMER_PATH}\n${timer}`);
    return 0;
  }
  ensureDirs();
  mkdirSync(SYSTEMD_DIR, { recursive: true });
  writeFileSync(SERVICE_PATH, service, 'utf-8');
  writeFileSync(TIMER_PATH, timer, 'utf-8');
  spawnQuiet('systemctl', ['--user', 'daemon-reload']);
  const enabled = spawnQuiet('systemctl', ['--user', 'enable', '--now', 'career-ops.timer']);
  if (enabled.status !== 0) {
    console.log(yellow(`Wrote ${SERVICE_PATH} and ${TIMER_PATH}, but systemctl enable failed.`));
    console.log(dim((enabled.stderr || enabled.stdout || '').trim()));
    return 1;
  }
  console.log(green(`Installed systemd user timer: ${TIMER_PATH}`));
  return 0;
}

function installWindows(opts, cadence) {
  const command = `${process.execPath} ${runArgs({ maxJobs: opts.maxJobs }).map(a => `"${a.replaceAll('"', '\\"')}"`).join(' ')}`;
  console.log('Windows auto-install is not supported yet. Create a scheduled task with:');
  console.log(`schtasks /Create /SC MINUTE /MO ${Math.ceil(cadence.seconds / 60)} /TN career-ops /TR "${command}"`);
  return 0;
}

function latestRunLog() {
  if (!existsSync(LOG_DIR)) return null;
  const files = readdirSync(LOG_DIR)
    .filter(f => /^run-.*\.ndjson$/.test(f))
    .sort();
  const latest = files.at(-1);
  if (!latest) return null;
  const path = join(LOG_DIR, latest);
  try {
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const final = [...lines].reverse().find((line) => line.event === 'run_finished') || lines.at(-1) || null;
    const lastError = [...lines].reverse().find((line) => line.level === 'error') || null;
    return { path, data: final, lines, lastError };
  } catch {
    return { path, data: null, lines: [], lastError: null };
  }
}

function installedCadenceSeconds() {
  if (existsSync(PLIST_PATH)) {
    const m = readFileSync(PLIST_PATH, 'utf-8').match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    if (m) return parseInt(m[1], 10);
  }
  if (existsSync(TIMER_PATH)) {
    const m = readFileSync(TIMER_PATH, 'utf-8').match(/OnUnitActiveSec=(\d+)s/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function status() {
  const latest = latestRunLog();
  const cadenceSeconds = installedCadenceSeconds();
  const installed = existsSync(PLIST_PATH) || existsSync(TIMER_PATH);
  console.log(`${bold('career-ops schedule status')}`);
  console.log(`installed: ${installed ? 'yes' : 'no'}`);
  if (cadenceSeconds) console.log(`cadence: every ${cadenceSeconds}s`);
  if (!latest) {
    console.log('last-run: never');
    console.log('next-run: unknown');
    return 0;
  }
  const data = latest.data || {};
  const last = data.endedAt || data.ts || data.startedAt || timestampFromRunLog(latest.path);
  const exitCode = data.status === 'failed' || data.aborted ? 1 : 0;
  console.log(`last-run: ${last}`);
  console.log(`final-status: ${data.status || 'unknown'}`);
  console.log(`step-count: ${data.stepCount ?? latest.lines.filter((line) => line.event === 'step_finished' || line.event === 'step_failed').length}`);
  console.log(`last-exit-code: ${exitCode}`);
  if (latest.lastError) console.log(`last-error: ${latest.lastError.msg || latest.lastError.error || 'unknown'}`);
  if (cadenceSeconds && last) {
    const next = new Date(new Date(last).getTime() + cadenceSeconds * 1000);
    if (!Number.isNaN(next.getTime())) console.log(`next-run: ${next.toISOString()}`);
  } else {
    console.log('next-run: unknown');
  }
  console.log(dim(`log: ${latest.path}`));
  return 0;
}

function timestampFromRunLog(path) {
  const m = path.match(/run-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
  return m ? `${m[1].replace(/T/, 'T').replace(/-(\d{2})-(\d{2})$/, ':$1:$2')}Z` : null;
}

function uninstall() {
  let removed = false;
  if (existsSync(PLIST_PATH)) {
    const domain = uid() == null ? null : `gui/${uid()}`;
    if (domain) spawnQuiet('launchctl', ['bootout', domain, PLIST_PATH]);
    else spawnQuiet('launchctl', ['unload', PLIST_PATH]);
    rmSync(PLIST_PATH, { force: true });
    console.log(green(`Removed ${PLIST_PATH}`));
    removed = true;
  }
  if (existsSync(TIMER_PATH) || existsSync(SERVICE_PATH)) {
    spawnQuiet('systemctl', ['--user', 'disable', '--now', 'career-ops.timer']);
    rmSync(TIMER_PATH, { force: true });
    rmSync(SERVICE_PATH, { force: true });
    spawnQuiet('systemctl', ['--user', 'daemon-reload']);
    console.log(green('Removed systemd user timer/service'));
    removed = true;
  }
  if (!removed) console.log('No schedule installed.');
  return 0;
}

function runOnce(maxJobs) {
  return new Promise((resolveP) => {
    const args = runArgs({ maxJobs });
    const env = { ...process.env, CAREER_OPS_RUN_ID: process.env.CAREER_OPS_RUN_ID || `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 10)}` };
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env });
    child.on('exit', code => resolveP(code ?? 0));
    child.on('error', () => resolveP(1));
  });
}

async function daemon(opts, cadence) {
  console.log(`career-ops schedule daemon running every ${cadence.input}. Ctrl+C to stop.`);
  let running = false;
  const tick = async () => {
    if (running) {
      console.log(yellow('Previous scheduled run is still active; skipping tick.'));
      return;
    }
    running = true;
    const logger = createLogger({ runId: process.env.CAREER_OPS_RUN_ID || `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 10)}`, cmd: 'schedule' });
    logger.event('step_started', { step: 'scheduled_run' });
    try {
      const code = await runOnce(opts.maxJobs);
      logger.event(code === 0 ? 'step_finished' : 'step_failed', { step: 'scheduled_run', code, level: code === 0 ? 'info' : 'error' });
    }
    finally { running = false; }
  };
  await tick();
  setInterval(tick, cadence.ms);
  return new Promise(() => {});
}

export default async function schedule(argv = []) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`career-ops schedule: ${e.message}`);
    return 2;
  }
  if (opts.help || opts.cmd === 'help') { printHelp(); return 0; }

  if (opts.cmd === 'status') return status();
  if (opts.cmd === 'uninstall') return uninstall();

  if (opts.cmd === 'install' || opts.cmd === 'daemon') {
    if (!opts.every) {
      console.error('career-ops schedule: --every is required');
      return 2;
    }
    let cadence;
    try { cadence = parseCadence(opts.every); }
    catch (e) { console.error(`career-ops schedule: ${e.message}`); return 2; }

    if (opts.cmd === 'daemon') return daemon(opts, cadence);
    const p = platform();
    if (p === 'darwin') return installMac(opts, cadence);
    if (p === 'linux') return installLinux(opts, cadence);
    if (p === 'win32') return installWindows(opts, cadence);
    console.error(`career-ops schedule: unsupported platform ${p}`);
    return 1;
  }

  console.error(`career-ops schedule: unknown subcommand ${opts.cmd}`);
  return 2;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  schedule(process.argv.slice(2)).then(code => process.exit(code ?? 0));
}
