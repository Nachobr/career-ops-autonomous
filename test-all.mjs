#!/usr/bin/env node

/**
 * test-all.mjs — Comprehensive test suite for career-ops
 *
 * Run before merging any PR or pushing changes.
 * Tests: syntax, scripts, dashboard, data contract, personal data, paths.
 *
 * Usage:
 *   node test-all.mjs           # Run all tests
 *   node test-all.mjs --quick   # Skip dashboard build (faster)
 */

import { execSync, execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const QUICK = process.argv.includes('--quick');

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

function run(cmd, args = [], opts = {}) {
  try {
    if (Array.isArray(args) && args.length > 0) {
      return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
    }
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function fileExists(path) { return existsSync(join(ROOT, path)); }
function readFile(path) { return readFileSync(join(ROOT, path), 'utf-8'); }

console.log('\n🧪 career-ops test suite\n');

// ── 1. SYNTAX CHECKS ────────────────────────────────────────────

console.log('1. Syntax checks');

const mjsFiles = readdirSync(ROOT).filter(f => f.endsWith('.mjs'));
for (const f of mjsFiles) {
  const result = run('node', ['--check', f]);
  if (result !== null) {
    pass(`${f} syntax OK`);
  } else {
    fail(`${f} has syntax errors`);
  }
}

// ── 2. SCRIPT EXECUTION ─────────────────────────────────────────

console.log('\n2. Script execution (graceful on empty data)');

const scripts = [
  { name: 'cv-sync-check.mjs', expectExit: 1, allowFail: true }, // fails without cv.md (normal in repo)
  { name: 'verify-pipeline.mjs', expectExit: 0 },
  { name: 'normalize-statuses.mjs', expectExit: 0 },
  { name: 'dedup-tracker.mjs', expectExit: 0 },
  { name: 'merge-tracker.mjs', expectExit: 0, env: { CAREER_OPS_TRACKER_DB: join(mkdtempSync(join(tmpdir(), 'career-ops-merge-db-')), 'applications.db') } },
  { name: 'update-system.mjs check', expectExit: 0 },
];

for (const { name, allowFail, env } of scripts) {
  const result = run('node', name.split(' '), { stdio: ['pipe', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
  if (result !== null) {
    pass(`${name} runs OK`);
  } else if (allowFail) {
    warn(`${name} exited with error (expected without user data)`);
  } else {
    fail(`${name} crashed`);
  }
}

// ── 2B. UNIFIED CLI ENTRYPOINT (Task 1) ─────────────────────────

console.log('\n2B. Unified CLI entrypoint (bin/career-ops.mjs)');

const cliSyntax = run('node', ['--check', 'bin/career-ops.mjs']);
if (cliSyntax !== null) pass('bin/career-ops.mjs syntax OK');
else fail('bin/career-ops.mjs has syntax errors');

const pkg = JSON.parse(readFile('package.json'));
if (pkg.bin?.['career-ops'] === 'bin/career-ops.mjs') {
  pass('package.json exposes career-ops bin');
} else {
  fail('package.json missing bin.career-ops');
}

const cliVersion = run('node', ['bin/career-ops.mjs', '--version']);
if (cliVersion === readFile('VERSION').trim()) {
  pass('career-ops --version reads VERSION');
} else {
  fail(`career-ops --version mismatch: ${cliVersion}`);
}

const cliTask1Help = run('node', ['bin/career-ops.mjs', '--help']);
const expectedCliCommands = [
  'scan', 'pipeline', 'eval', 'gemini-eval', 'pdf', 'latex', 'liveness',
  'merge', 'verify', 'normalize', 'dedup', 'doctor', 'patterns', 'followup',
  'apply', 'tracker', 'migrate-tracker', 'update', 'test', 'run', 'schedule', 'runner', 'review', 'login', 'colab',
];
const missingCliCommands = expectedCliCommands.filter(cmd => !new RegExp(`\\b${cmd}\\b`).test(cliTask1Help || ''));
if (cliTask1Help && missingCliCommands.length === 0) {
  pass('career-ops --help lists all Task 1 commands');
} else {
  fail(`career-ops --help missing commands: ${missingCliCommands.join(', ')}`);
}

const scanHelp = run('node', ['bin/career-ops.mjs', 'help', 'scan']);
if (scanHelp && scanHelp.includes('node scan.mjs')) {
  pass('career-ops help scan prints subcommand help');
} else {
  fail('career-ops help scan did not print expected help');
}

const trackerOut = run('node', ['bin/career-ops.mjs', 'tracker']);
if (trackerOut && trackerOut.includes('Application tracker') && trackerOut.includes('Status counts')) {
  pass('career-ops tracker prints tracker summary');
} else {
  fail('career-ops tracker did not print expected summary');
}

// ── 2C. END-TO-END RUN COMMAND (Task 3) ─────────────────────────

console.log('\n2C. End-to-end run command (commands/run.mjs)');

const runCmdSyntax = run('node', ['--check', 'commands/run.mjs']);
if (runCmdSyntax !== null) pass('commands/run.mjs syntax OK');
else fail('commands/run.mjs has syntax errors');

const batchPipelineSyntax = run('node', ['--check', 'batch-pipeline.mjs']);
if (batchPipelineSyntax !== null) pass('batch-pipeline.mjs syntax OK');
else fail('batch-pipeline.mjs has syntax errors');

const runHelp = run('node', ['bin/career-ops.mjs', 'run', '--help']);
if (runHelp && runHelp.includes('--dry-run') && runHelp.includes('--engine=runner|claude')) {
  pass('career-ops run --help exits 0 and documents Task 3 flags');
} else {
  fail('career-ops run --help missing expected flags');
}

const dryRunPlan = run('node', ['bin/career-ops.mjs', 'run', '--dry-run', '--only=doctor,scan,pipeline,merge,normalize,dedup,verify,followup']);
const expectedRunOrder = ['doctor', 'scan', 'pipeline', 'merge', 'normalize', 'dedup', 'verify', 'followup'];
let lastIdx = -1;
const planHasOrder = dryRunPlan && expectedRunOrder.every((step) => {
  const idx = dryRunPlan.indexOf(step);
  const ok = idx > lastIdx;
  lastIdx = idx;
  return ok;
});
if (planHasOrder && dryRunPlan.includes('Dry run')) {
  pass('career-ops run --dry-run prints ordered plan without executing steps');
} else {
  fail('career-ops run --dry-run did not print the expected ordered plan');
}

const maxJobsDryRun = run('node', ['bin/career-ops.mjs', 'run', '--dry-run', '--only=pipeline', '--max-jobs', '7', '--engine', 'runner']);
if (maxJobsDryRun && maxJobsDryRun.includes('max-jobs=7') && readFile('commands/run.mjs').includes('CAREER_OPS_MAX_JOBS')) {
  pass('career-ops run --max-jobs is accepted and forwarded to pipeline via env');
} else {
  fail('career-ops run --max-jobs dry-run/forwarding check failed');
}

const autoApplyDryRun = run('node', ['bin/career-ops.mjs', 'run', '--dry-run', '--only=pipeline', '--max-jobs', '1', '--auto-apply']);
if (autoApplyDryRun && autoApplyDryRun.includes('Auto-apply active') && autoApplyDryRun.includes('Final submit remains manual')) {
  pass('career-ops run --auto-apply is accepted and documents safe browser handoff');
} else {
  fail('career-ops run --auto-apply dry-run did not document browser handoff safety');
}

try {
  const loggerMod = await import(pathToFileURL(join(ROOT, 'lib', 'logger.mjs')).href);
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-logger-'));
  const file = join(tmp, 'run-test.ndjson');
  const logger = loggerMod.createLogger({ runId: 'test-run', file, cmd: 'test' });
  logger.info('hello', { step: 'unit' });
  logger.event('unit_event', { ok: true });
  const lines = readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  if (lines.length === 2 && lines.every((line) => line.ts && line.runId === 'test-run') && lines[1].event === 'unit_event') {
    pass('logger writes valid NDJSON lines');
  } else {
    fail('logger NDJSON lines missing expected fields');
  }

  for (let i = 0; i < 55; i++) writeFileSync(join(tmp, `run-2026-01-01T00-00-${String(i).padStart(2, '0')}-x.ndjson`), '{}\n');
  loggerMod.rotateLogs(tmp, 50);
  const kept = readdirSync(tmp).filter((f) => /^run-.*\.ndjson$/.test(f));
  if (kept.length === 50) pass('logger rotation keeps latest 50 run logs');
  else fail(`logger rotation kept ${kept.length} run logs`);
} catch (e) {
  fail(`logger unit tests crashed: ${e.message}`);
}

const runLogSmoke = run('node', ['bin/career-ops.mjs', 'run', '--dry-run', '--only=doctor']);
const logMatch = runLogSmoke && runLogSmoke.match(/log: (.*\.ndjson)/);
try {
  const logPath = logMatch?.[1];
  const lines = logPath ? readFileSync(logPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  if (lines.some((line) => line.event === 'run_started') && lines.some((line) => line.event === 'run_finished') && lines.every((line) => line.runId)) {
    pass('career-ops run --dry-run writes valid structured log with run id');
  } else {
    fail('career-ops run --dry-run structured log missing expected events/run id');
  }
} catch (e) {
  fail(`career-ops run structured log smoke failed: ${e.message}`);
}

const batchHelp = run('node', ['batch-pipeline.mjs', '--help']);
if (batchHelp && batchHelp.includes('--engine=runner|claude') && batchHelp.includes('--max-jobs')) {
  pass('batch-pipeline.mjs --help documents engine and max-job flags');
} else {
  fail('batch-pipeline.mjs --help missing Task 3 flags');
}

if (readFile('batch-pipeline.mjs').includes("import { runMode } from './modes/runner.mjs'") &&
    readFile('batch-pipeline.mjs').includes("process.env.CAREER_OPS_ENGINE || 'runner'")) {
  pass('batch-pipeline.mjs defaults to modes/runner.mjs engine');
} else {
  fail('batch-pipeline.mjs is not wired to runner as default engine');
}

// ── 2D. SCHEDULE COMMAND (Task 4) ───────────────────────────────

console.log('\n2D. Schedule command (commands/schedule.mjs)');

const scheduleSyntax = run('node', ['--check', 'commands/schedule.mjs']);
if (scheduleSyntax !== null) pass('commands/schedule.mjs syntax OK');
else fail('commands/schedule.mjs has syntax errors');

const scheduleHelp = run('node', ['bin/career-ops.mjs', 'schedule', '--help']);
if (scheduleHelp && scheduleHelp.includes('install --every 3d') && scheduleHelp.includes('daemon --every 12h')) {
  pass('career-ops schedule --help exits 0');
} else {
  fail('career-ops schedule --help missing expected usage');
}

const scheduleStatus = run('node', ['bin/career-ops.mjs', 'schedule', 'status']);
if (scheduleStatus && scheduleStatus.includes('career-ops schedule status') && scheduleStatus.includes('last-run:') && scheduleStatus.includes('final-status:')) {
  pass('career-ops schedule status exits 0');
} else {
  fail('career-ops schedule status did not print expected fields');
}

const loginHelp = run('node', ['bin/career-ops.mjs', 'help', 'login']);
if (loginHelp && loginHelp.includes('--status') && loginHelp.includes('--provider')) {
  pass('career-ops help login documents provider configuration');
} else {
  fail('career-ops help login missing expected usage');
}

const loginStatus = run('node', ['bin/career-ops.mjs', 'login', '--status']);
if (loginStatus && loginStatus.includes('career-ops login status') && loginStatus.includes('GEMINI_API_KEY')) {
  pass('career-ops login --status exits 0 without secrets');
} else {
  fail('career-ops login --status did not print expected provider status');
}

const doctorJson = run('node', ['doctor.mjs', '--json'], { env: { ...process.env, STUB_LLM: '1' } });
try {
  const parsed = JSON.parse(doctorJson || 'null');
  if (typeof parsed?.ok === 'boolean' && Array.isArray(parsed?.checks)) pass('doctor.mjs --json emits structured check results');
  else fail('doctor.mjs --json missing ok/checks');
} catch {
  fail('doctor.mjs --json did not emit valid JSON');
}

try {
  const scheduleMod = await import(pathToFileURL(join(ROOT, 'commands', 'schedule.mjs')).href);
  const cases = { '30m': 1800, '12h': 43200, '3d': 259200, '1w': 604800 };
  const ok = Object.entries(cases).every(([input, seconds]) => scheduleMod.parseCadence(input).seconds === seconds);
  if (ok) pass('parseCadence supports 30m, 12h, 3d, and 1w');
  else fail('parseCadence returned unexpected seconds');

  const cadence = scheduleMod.parseCadence('3d');
  const plist = scheduleMod.renderLaunchdPlist({ cadence, maxJobs: 2 });
  const timer = scheduleMod.renderSystemdTimer({ cadence });
  const service = scheduleMod.renderSystemdService({ maxJobs: 2 });
  if (plist.includes('<integer>259200</integer>') && plist.includes('<string>--max-jobs</string>') &&
      timer.includes('OnUnitActiveSec=259200s') && service.includes('--max-jobs')) {
    pass('schedule renders launchd plist and systemd units with cadence/max-jobs');
  } else {
    fail('schedule rendered plist/systemd output is missing cadence or max-jobs');
  }
} catch (e) {
  fail(`schedule module import/tests failed: ${e.message}`);
}

if (readFile('commands/run.mjs').includes("data', '.run.lock'") && readFile('commands/run.mjs').includes('acquireRunLock')) {
  pass('career-ops run uses data/.run.lock to prevent overlaps');
} else {
  fail('career-ops run lock handling missing');
}

// ── 2E. NOTIFICATIONS (Task B) ──────────────────────────────────

console.log('\n2E. Notifications (Task B)');

function readNotificationLines(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf-8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => JSON.parse(line));
}

function writeNotifyProfile(dir, body) {
  const profile = join(dir, 'profile.yml');
  writeFileSync(profile, body, 'utf-8');
  return profile;
}

const notifySyntax = run('node', ['--check', 'lib/notify.mjs']);
if (notifySyntax !== null) pass('lib/notify.mjs syntax OK');
else fail('lib/notify.mjs has syntax errors');

const oldNotifyEnv = {
  audit: process.env.CAREER_OPS_NOTIFY_AUDIT,
  profile: process.env.CAREER_OPS_NOTIFY_PROFILE,
  runId: process.env.CAREER_OPS_RUN_ID,
  slack: process.env.SLACK_WEBHOOK,
  testWebhook: process.env.TEST_WEBHOOK,
};

try {
  const notifyMod = await import(pathToFileURL(join(ROOT, 'lib', 'notify.mjs')).href);
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-notify-'));
  const audit = join(tmp, 'notifications.ndjson');
  process.env.CAREER_OPS_NOTIFY_AUDIT = audit;
  process.env.CAREER_OPS_NOTIFY_PROFILE = writeNotifyProfile(tmp, 'notifications:\n  enabled: true\n  channels:\n    - type: file\n      path: data/logs/notifications.ndjson\n      min_severity: info\n');
  process.env.CAREER_OPS_RUN_ID = 'notify-test-run';
  await notifyMod.notify({ kind: 'test', title: 't', body: 'b', severity: 'info' });
  const lines = readNotificationLines(audit);
  const line = lines[0];
  if (line?.ts && line.runId === 'notify-test-run' && line.kind === 'test' && line.severity === 'info' && line.channels?.some((c) => c.type === 'file' && c.ok)) {
    pass('notify file channel writes valid NDJSON with run id');
  } else {
    fail('notify file channel NDJSON missing expected fields');
  }

} catch (e) {
  fail(`notify base tests crashed: ${e.message}`);
}

try {
  const notifyMod = await import(pathToFileURL(join(ROOT, 'lib', 'notify.mjs')).href);
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-notify-filter-'));
  const audit = join(tmp, 'severity.ndjson');
  process.env.CAREER_OPS_NOTIFY_AUDIT = audit;
  process.env.CAREER_OPS_NOTIFY_PROFILE = writeNotifyProfile(tmp, 'notifications:\n  enabled: true\n  channels:\n    - type: file\n      path: data/logs/notifications.ndjson\n      min_severity: info\n    - type: slack\n      webhook_env: TEST_WEBHOOK\n      min_severity: warn\n');
  delete process.env.TEST_WEBHOOK;
  await notifyMod.notify({ kind: 'test', title: 'info', body: 'body', severity: 'info' });
  const line = readNotificationLines(audit)[0];
  if (line?.channels?.some((c) => c.type === 'slack' && c.skipped_by_severity === true) && line.channels.some((c) => c.type === 'file' && c.ok)) {
    pass('notify severity filtering records skipped channel and still writes file audit');
  } else {
    fail('notify severity filtering did not record expected channel results');
  }
} catch (e) {
  fail(`notify severity filtering test crashed: ${e.message}`);
}

try {
  const notifyMod = await import(pathToFileURL(join(ROOT, 'lib', 'notify.mjs')).href);
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-notify-disabled-'));
  const audit = join(tmp, 'disabled.ndjson');
  process.env.CAREER_OPS_NOTIFY_AUDIT = audit;
  process.env.CAREER_OPS_NOTIFY_PROFILE = writeNotifyProfile(tmp, 'notifications:\n  enabled: false\n  channels:\n    - type: slack\n      webhook_env: TEST_WEBHOOK\n');
  await notifyMod.notify({ kind: 'test', title: 'disabled', body: 'body' });
  const line = readNotificationLines(audit)[0];
  if (line?.skipped === true && line.channels?.some((c) => c.type === 'file' && c.ok) && line.channels.some((c) => c.type === 'slack' && c.skipped === true)) {
    pass('notify disabled config still writes audit and marks outbound skipped');
  } else {
    fail('notify disabled config did not write expected skipped audit entry');
  }
} catch (e) {
  fail(`notify disabled config test crashed: ${e.message}`);
}

try {
  const notifyMod = await import(pathToFileURL(join(ROOT, 'lib', 'notify.mjs')).href);
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-notify-missing-'));
  const audit = join(tmp, 'missing.ndjson');
  process.env.CAREER_OPS_NOTIFY_AUDIT = audit;
  process.env.CAREER_OPS_NOTIFY_PROFILE = writeNotifyProfile(tmp, 'notifications:\n  enabled: true\n  channels:\n    - type: slack\n      webhook_env: SLACK_WEBHOOK\n');
  delete process.env.SLACK_WEBHOOK;
  await notifyMod.notify({ kind: 'test', title: 'missing webhook', body: 'body' });
  const line = readNotificationLines(audit)[0];
  if (line?.channels?.some((c) => c.type === 'slack' && c.ok === false && /missing/.test(c.reason || ''))) {
    pass('notify missing webhook env warns via audit without crashing');
  } else {
    fail('notify missing webhook env did not record expected failure');
  }
} catch (e) {
  fail(`notify missing webhook test crashed: ${e.message}`);
}

try {
  const notifyMod = await import(pathToFileURL(join(ROOT, 'lib', 'notify.mjs')).href);
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-notify-webhook-'));
  const audit = join(tmp, 'webhook.ndjson');
  let received = null;
  let count = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      count++;
      received = JSON.parse(body || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolveP) => server.listen(0, '127.0.0.1', resolveP));
  const address = server.address();
  process.env.TEST_WEBHOOK = `http://127.0.0.1:${address.port}/hook`;
  process.env.CAREER_OPS_NOTIFY_AUDIT = audit;
  process.env.CAREER_OPS_NOTIFY_PROFILE = writeNotifyProfile(tmp, 'notifications:\n  enabled: true\n  channels:\n    - type: slack\n      webhook_env: TEST_WEBHOOK\n');
  await notifyMod.notify({ kind: 'test', title: 'webhook', body: 'hello' });
  await new Promise((resolveP) => server.close(resolveP));
  const line = readNotificationLines(audit)[0];
  if (count === 1 && received?.text?.includes('*INFO*') && line?.channels?.some((c) => c.type === 'slack' && c.ok === true)) {
    pass('notify mock Slack webhook receives one POST and records ok');
  } else {
    fail('notify mock Slack webhook did not receive expected POST/audit result');
  }
} catch (e) {
  fail(`notify mock webhook test crashed: ${e.message}`);
}

try {
  const notifyMod = await import(pathToFileURL(join(ROOT, 'lib', 'notify.mjs')).href);
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-notify-redact-'));
  const audit = join(tmp, 'redact.ndjson');
  let received = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = JSON.parse(body || '{}');
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolveP) => server.listen(0, '127.0.0.1', resolveP));
  process.env.TEST_WEBHOOK = `http://127.0.0.1:${server.address().port}/hook`;
  process.env.CAREER_OPS_NOTIFY_AUDIT = audit;
  process.env.CAREER_OPS_NOTIFY_PROFILE = writeNotifyProfile(tmp, 'notifications:\n  enabled: true\n  channels:\n    - type: slack\n      webhook_env: TEST_WEBHOOK\n');
  const secretBody = `token ${'sk-' + 'test1234567890ABCD'} belongs to jane.doe@example.com`;
  await notifyMod.notify({ kind: 'test', title: 'redact', body: secretBody });
  await new Promise((resolveP) => server.close(resolveP));
  const line = readNotificationLines(audit)[0];
  if (received?.text?.includes('sk-[REDACTED]') && received.text.includes('j***@example.com') && line?.body === secretBody) {
    pass('notify redacts outbound body while retaining original file audit');
  } else {
    fail('notify redaction did not match outbound/audit expectations');
  }
} catch (e) {
  fail(`notify redaction test crashed: ${e.message}`);
}

try {
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-notify-run-'));
  const audit = join(tmp, 'run.ndjson');
  const profile = writeNotifyProfile(tmp, 'notifications:\n  enabled: true\n  channels:\n    - type: file\n      path: data/logs/notifications.ndjson\n');
  const env = { ...process.env, CAREER_OPS_NOTIFY_AUDIT: audit, CAREER_OPS_NOTIFY_PROFILE: profile };
  const out = run('node', ['bin/career-ops.mjs', 'run', '--dry-run', '--only=doctor'], { env });
  const lines = readNotificationLines(audit);
  if (out && lines.some((line) => line.kind === 'run_dryrun')) {
    pass('career-ops run --dry-run emits run_dryrun notification audit');
  } else {
    fail('career-ops run --dry-run did not emit run_dryrun audit entry');
  }
  const before = lines.length;
  const outNoAlerts = run('node', ['bin/career-ops.mjs', 'run', '--no-alerts', '--dry-run', '--only=doctor'], { env });
  const after = readNotificationLines(audit).length;
  if (outNoAlerts && after === before) {
    pass('career-ops run --no-alerts skips notification audit');
  } else {
    fail('career-ops run --no-alerts wrote an unexpected notification audit line');
  }
} catch (e) {
  fail(`run notification wiring tests crashed: ${e.message}`);
} finally {
  if (oldNotifyEnv.audit == null) delete process.env.CAREER_OPS_NOTIFY_AUDIT; else process.env.CAREER_OPS_NOTIFY_AUDIT = oldNotifyEnv.audit;
  if (oldNotifyEnv.profile == null) delete process.env.CAREER_OPS_NOTIFY_PROFILE; else process.env.CAREER_OPS_NOTIFY_PROFILE = oldNotifyEnv.profile;
  if (oldNotifyEnv.runId == null) delete process.env.CAREER_OPS_RUN_ID; else process.env.CAREER_OPS_RUN_ID = oldNotifyEnv.runId;
  if (oldNotifyEnv.slack == null) delete process.env.SLACK_WEBHOOK; else process.env.SLACK_WEBHOOK = oldNotifyEnv.slack;
  if (oldNotifyEnv.testWebhook == null) delete process.env.TEST_WEBHOOK; else process.env.TEST_WEBHOOK = oldNotifyEnv.testWebhook;
}

// ── 2F. RETRY + DEAD-LETTER QUEUE (Task 9) ─────────────────────

console.log('\n2F. Retry + dead-letter queue (Task 9)');

for (const f of ['lib/retry.mjs', 'lib/dead-letter.mjs', 'commands/retry-dead-letter.mjs']) {
  const result = run('node', ['--check', f]);
  if (result !== null) pass(`${f} syntax OK`);
  else fail(`${f} has syntax errors`);
}

try {
  const { withRetry } = await import(pathToFileURL(join(ROOT, 'lib', 'retry.mjs')).href);
  let calls = 0;
  const out = await withRetry(() => {
    calls++;
    if (calls < 3) throw new Error('temporary failure');
    return 'ok';
  }, { attempts: 4, baseMs: 1, jitter: 0 });
  if (out === 'ok' && calls === 3) pass('withRetry succeeds after transient failures');
  else fail('withRetry did not retry until success as expected');
} catch (e) {
  fail(`withRetry success-after-failures test crashed: ${e.message}`);
}

try {
  const { withRetry } = await import(pathToFileURL(join(ROOT, 'lib', 'retry.mjs')).href);
  let calls = 0;
  try {
    await withRetry(() => { calls++; throw new Error('still down'); }, { attempts: 2, baseMs: 1, jitter: 0 });
    fail('withRetry exhaustion unexpectedly resolved');
  } catch (e) {
    if (calls === 2 && e.attempts === 2) pass('withRetry exhaustion annotates attempts');
    else fail('withRetry exhaustion did not call/annotate attempts correctly');
  }
} catch (e) {
  fail(`withRetry exhaustion test crashed: ${e.message}`);
}

try {
  const { withRetry } = await import(pathToFileURL(join(ROOT, 'lib', 'retry.mjs')).href);
  let calls = 0;
  try {
    await withRetry(() => { calls++; throw new Error('auth failed'); }, { attempts: 4, baseMs: 1, retryOn: () => false });
    fail('withRetry retryOn=false unexpectedly resolved');
  } catch {
    if (calls === 1) pass('withRetry retryOn=false short-circuits');
    else fail(`withRetry retryOn=false called ${calls} times`);
  }
} catch (e) {
  fail(`withRetry retryOn=false test crashed: ${e.message}`);
}

const oldDlqEnv = {
  dlq: process.env.CAREER_OPS_DEAD_LETTER,
  runId: process.env.CAREER_OPS_RUN_ID,
};
try {
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-dlq-'));
  const dlq = join(tmp, 'dead-letter.ndjson');
  process.env.CAREER_OPS_DEAD_LETTER = dlq;
  process.env.CAREER_OPS_RUN_ID = 'test';
  const mod = await import(`${pathToFileURL(join(ROOT, 'lib', 'dead-letter.mjs')).href}?test=${Date.now()}`);
  mod.recordDeadLetter({ source: 'scrape', url: 'https://example.com/a', error: 'HTTP 503', attempts: 4 });
  mod.recordDeadLetter({ source: 'llm', url: 'https://example.com/b', error: 'timeout\nstack', attempts: 2 });
  const entries = mod.readDeadLetter();
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  if (entries.length === 2 && entries[0].source === 'scrape' && entries[1].url === 'https://example.com/b' && iso.test(entries[0].ts) && entries[0].runId === 'test') {
    pass('dead-letter round-trip writes and reads isolated NDJSON');
  } else {
    fail('dead-letter round-trip missing expected fields');
  }
} catch (e) {
  fail(`dead-letter round-trip test crashed: ${e.message}`);
} finally {
  if (oldDlqEnv.dlq == null) delete process.env.CAREER_OPS_DEAD_LETTER; else process.env.CAREER_OPS_DEAD_LETTER = oldDlqEnv.dlq;
  if (oldDlqEnv.runId == null) delete process.env.CAREER_OPS_RUN_ID; else process.env.CAREER_OPS_RUN_ID = oldDlqEnv.runId;
}

const retryDlqHelp = run('node', ['bin/career-ops.mjs', 'retry-dead-letter', '--help']);
if (retryDlqHelp !== null && retryDlqHelp.includes('--list') && retryDlqHelp.includes('--clear')) {
  pass('career-ops retry-dead-letter --help exits 0');
} else {
  fail('career-ops retry-dead-letter --help missing expected usage');
}

const retryDlqCliHelp = run('node', ['bin/career-ops.mjs', '--help']);
if (retryDlqCliHelp !== null && retryDlqCliHelp.includes('retry-dead-letter')) {
  pass('career-ops --help lists retry-dead-letter');
} else {
  fail('career-ops --help does not list retry-dead-letter');
}

// ── 2G. SQLITE TRACKER MIRROR (Task 10) ─────────────────────────

console.log('\n2G. SQLite tracker mirror (Task 10)');

for (const f of ['lib/tracker-db.mjs', 'commands/migrate-tracker.mjs']) {
  const result = run('node', ['--check', f]);
  if (result !== null) pass(`${f} syntax OK`);
  else fail(`${f} has syntax errors`);
}

const trackerSample = `# Application Tracker

| ID | Fecha | Empresa | Rol | Score | Estado | PDF | Report |
|----|-------|---------|-----|-------|--------|-----|--------|
| 42 | 2026-05-20 | Acme | Senior AI Engineer | 4.5/5 | Evaluated | ✅ | [42](reports/042-acme.md) |  |
| 17 | 2026-05-19 | Beta Co | Product Manager | N/A | SKIP |  | [17](reports/017-beta.md) | Not a fit |
| 31 | 2026-05-18 | Gamma | Staff Platform Engineer | 3.7/5 | Applied | ✅ | [31](reports/031-gamma.md) | Followed up |
`;

try {
  const trackerMod = await import(`${pathToFileURL(join(ROOT, 'lib', 'tracker-db.mjs')).href}?test=${Date.now()}`);
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-tracker-'));
  const dbPath = join(tmp, 'applications.db');
  const db = trackerMod.openDb(dbPath);
  try {
    const rows = trackerMod.parseTrackerMarkdown(trackerSample);
    trackerMod.syncApplications(db, rows);
    const rendered = trackerMod.renderTrackerMarkdown(trackerMod.getApplications(db));
    if (rendered.trimEnd() === trackerSample.trimEnd()) pass('tracker markdown → DB → markdown round-trip is stable');
    else fail('tracker markdown round-trip changed output');

    trackerMod.syncApplications(db, rows);
    if (trackerMod.rowCount(db) === rows.length) pass('tracker migration/upsert is idempotent');
    else fail(`tracker row count changed after idempotent import: ${trackerMod.rowCount(db)}`);

    const byId = new Map(trackerMod.getApplications(db).map((row) => [row.id, row]));
    if (byId.get(42)?.score_num === 4.5 && byId.get(17)?.score_num === null) pass('tracker score_num derives numeric scores and preserves N/A as null');
    else fail('tracker score_num derivation failed');
  } finally {
    trackerMod.closeDb(db);
  }
} catch (e) {
  fail(`tracker round-trip/idempotency tests crashed: ${e.message}`);
}

try {
  const trackerMod = await import(`${pathToFileURL(join(ROOT, 'lib', 'tracker-db.mjs')).href}?concurrency=${Date.now()}`);
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-tracker-concurrency-'));
  const dbPath = join(tmp, 'applications.db');
  const db1 = trackerMod.openDb(dbPath);
  const db2 = trackerMod.openDb(dbPath);
  try {
    trackerMod.upsertApplication(db1, { id: 1, date: '2026-05-20', company: 'One', role: 'Role One', score: '4.0/5', status: 'Evaluated', pdf: '✅', report: '[1](reports/1.md)', notes: '' });
    trackerMod.upsertApplication(db2, { id: 2, date: '2026-05-21', company: 'Two', role: 'Role Two', score: 'N/A', status: 'SKIP', pdf: '', report: '[2](reports/2.md)', notes: '' });
    if (trackerMod.rowCount(db1) === 2 && trackerMod.rowCount(db2) === 2) pass('tracker WAL concurrency smoke writes from two connections');
    else fail('tracker WAL concurrency smoke row count mismatch');
  } finally {
    trackerMod.closeDb(db1);
    trackerMod.closeDb(db2);
  }
} catch (e) {
  fail(`tracker concurrency smoke crashed: ${e.message}`);
}

const migrateHelp = run('node', ['bin/career-ops.mjs', 'migrate-tracker', '--help']);
if (migrateHelp !== null && migrateHelp.includes('--dry-run')) pass('career-ops migrate-tracker --help exits 0');
else fail('career-ops migrate-tracker --help missing expected usage');

const trackerExportHelp = run('node', ['bin/career-ops.mjs', 'tracker', 'export', '--help']);
if (trackerExportHelp !== null && trackerExportHelp.includes('--format=md|csv|json')) pass('career-ops tracker export --help exits 0');
else fail('career-ops tracker export --help missing expected usage');

// ── 3. LIVENESS CLASSIFICATION ──────────────────────────────────

console.log('\n3. Liveness classification');

try {
  const { classifyLiveness } = await import(pathToFileURL(join(ROOT, 'liveness-core.mjs')).href);

  const expiredChromeApply = classifyLiveness({
    finalUrl: 'https://example.com/jobs/closed-role',
    bodyText: 'Company Careers\nApply\nThe job you are looking for is no longer open.',
    applyControls: [],
  });
  if (expiredChromeApply.result === 'expired') {
    pass('Expired pages are not revived by nav/footer "Apply" text');
  } else {
    fail(`Expired page misclassified as ${expiredChromeApply.result}`);
  }

  const activeWorkdayPage = classifyLiveness({
    finalUrl: 'https://example.workday.com/job/123',
    bodyText: [
      '663 JOBS FOUND',
      'Senior AI Engineer',
      'Join our applied AI team to ship production systems, partner with customers, and own delivery across evaluation, deployment, and reliability.',
    ].join('\n'),
    applyControls: ['Apply for this Job'],
  });
  if (activeWorkdayPage.result === 'active') {
    pass('Visible apply controls still keep real job pages active');
  } else {
    fail(`Active job page misclassified as ${activeWorkdayPage.result}`);
  }

  const closedMycareersfuture = classifyLiveness({
    finalUrl: 'https://www.mycareersfuture.gov.sg/job/engineering/senior-staff-embedded-software-engineer',
    bodyText: [
      'Senior Staff Embedded Software Engineer',
      'MaxLinear Asia Singapore Private Limited',
      '9 applications    Posted 27 Oct 2025    Closed on 26 Nov 2025',
      'Applications have closed for this job',
      'Log in to Apply',
      "You'll need to log in with Singpass to verify your identity.",
      'Roles & Responsibilities: design, develop and maintain embedded firmware for broadband communications ICs.',
    ].join('\n'),
    applyControls: ['Log in to Apply'],
  });
  if (closedMycareersfuture.result === 'expired') {
    pass('Closed postings with "Applications have closed" banner are detected');
  } else {
    fail(`Closed mycareersfuture posting misclassified as ${closedMycareersfuture.result}`);
  }
} catch (e) {
  fail(`Liveness classification tests crashed: ${e.message}`);
}

// ── 4. DASHBOARD BUILD ──────────────────────────────────────────

if (!QUICK) {
  console.log('\n4. Dashboard build');
  const goBuild = run('cd dashboard && go build -o /tmp/career-dashboard-test . 2>&1');
  if (goBuild !== null) {
    pass('Dashboard compiles');
  } else {
    fail('Dashboard build failed');
  }
} else {
  console.log('\n4. Dashboard build (skipped --quick)');
}

// ── 5. DATA CONTRACT ────────────────────────────────────────────

console.log('\n5. Data contract validation');

// Check system files exist
const systemFiles = [
  'CLAUDE.md', 'VERSION', 'DATA_CONTRACT.md',
  'modes/_shared.md', 'modes/_profile.template.md',
  'modes/oferta.md', 'modes/pdf.md', 'modes/scan.md',
  'templates/states.yml', 'templates/cv-template.html',
  '.claude/skills/career-ops/SKILL.md',
];

for (const f of systemFiles) {
  if (fileExists(f)) {
    pass(`System file exists: ${f}`);
  } else {
    fail(`Missing system file: ${f}`);
  }
}

// Check user files are NOT tracked (gitignored)
const userFiles = [
  'config/profile.yml', 'modes/_profile.md', 'portals.yml',
];
for (const f of userFiles) {
  const tracked = run('git', ['ls-files', f]);
  if (tracked === '') {
    pass(`User file gitignored: ${f}`);
  } else if (tracked === null) {
    pass(`User file gitignored: ${f}`);
  } else {
    fail(`User file IS tracked (should be gitignored): ${f}`);
  }
}

// ── 6. PERSONAL DATA LEAK CHECK ─────────────────────────────────

console.log('\n6. Personal data leak check');

const leakPatterns = [
  'Santiago', 'santifer.io', 'Santifer iRepair', 'Zinkee', 'ALMAS',
  'hi@santifer.io', '688921377', '/Users/santifer/',
];

const scanExtensions = ['md', 'yml', 'html', 'mjs', 'sh', 'go', 'json'];
const allowedFiles = [
  // English README + localized translations (all legitimately credit Santiago)
  'README.md', 'README.es.md', 'README.ja.md', 'README.ko-KR.md',
  'README.pt-BR.md', 'README.ru.md',
  // Standard project files
  'LICENSE', 'CITATION.cff', 'CONTRIBUTING.md',
  'package.json', '.github/FUNDING.yml', 'CLAUDE.md', 'AGENTS.md', 'go.mod', 'test-all.mjs',
  // Community / governance files (added in v1.3.0, all legitimately reference the maintainer)
  'CODE_OF_CONDUCT.md', 'GOVERNANCE.md', 'SECURITY.md', 'SUPPORT.md',
  '.github/SECURITY.md',
  // Dashboard credit string
  'dashboard/internal/ui/screens/pipeline.go',
];

// Build pathspec for git grep — only scan tracked files matching these
// extensions. This is what `grep -rn` was trying to do, but git-aware:
// untracked files (debate artifacts, AI tool scratch, local plans/) and
// gitignored files can't trigger false positives because they were never
// going to reach a commit anyway.
const grepPathspec = scanExtensions.map(e => `'*.${e}'`).join(' ');

let leakFound = false;
for (const pattern of leakPatterns) {
  const result = run(
    `git grep -n "${pattern}" -- ${grepPathspec} 2>/dev/null`
  );
  if (result) {
    for (const line of result.split('\n')) {
      const file = line.split(':')[0];
      if (allowedFiles.some(a => file.includes(a))) continue;
      if (file.includes('dashboard/go.mod')) continue;
      warn(`Possible personal data in ${file}: "${pattern}"`);
      leakFound = true;
    }
  }
}
if (!leakFound) {
  pass('No personal data leaks outside allowed files');
}

// ── 7. ABSOLUTE PATH CHECK ──────────────────────────────────────

console.log('\n7. Absolute path check');

// Same git grep approach: only scans tracked files. Untracked AI tool
// outputs, local debate artifacts, etc. can't false-positive here.
const absPathResult = run(
  `git grep -n "/Users/" -- '*.mjs' '*.sh' '*.md' '*.go' '*.yml' 2>/dev/null | grep -v README.md | grep -v LICENSE | grep -v CLAUDE.md | grep -v test-all.mjs`
);
if (!absPathResult) {
  pass('No absolute paths in code files');
} else {
  for (const line of absPathResult.split('\n').filter(Boolean)) {
    fail(`Absolute path: ${line.slice(0, 100)}`);
  }
}

// ── 8. MODE FILE INTEGRITY ──────────────────────────────────────

console.log('\n8. Mode file integrity');

const expectedModes = [
  '_shared.md', '_profile.template.md', 'oferta.md', 'pdf.md', 'scan.md',
  'batch.md', 'apply.md', 'auto-pipeline.md', 'contacto.md', 'deep.md',
  'ofertas.md', 'pipeline.md', 'project.md', 'tracker.md', 'training.md',
];

for (const mode of expectedModes) {
  if (fileExists(`modes/${mode}`)) {
    pass(`Mode exists: ${mode}`);
  } else {
    fail(`Missing mode: ${mode}`);
  }
}

// Check _shared.md references _profile.md
const shared = readFile('modes/_shared.md');
if (shared.includes('_profile.md')) {
  pass('_shared.md references _profile.md');
} else {
  fail('_shared.md does NOT reference _profile.md');
}

// ── 9. AGENTS.md INTEGRITY ──────────────────────────────────────

console.log('\n9. AGENTS.md integrity');

const agents = readFile('AGENTS.md');
const requiredSections = [
  'Data Contract', 'Update Check', 'Ethical Use',
  'Offer Verification', 'Canonical States', 'TSV Format',
  'First Run', 'Onboarding',
];

for (const section of requiredSections) {
  if (agents.includes(section)) {
    pass(`AGENTS.md has section: ${section}`);
  } else {
    fail(`AGENTS.md missing section: ${section}`);
  }
}

// ── 10. VERSION FILE ─────────────────────────────────────────────

console.log('\n10. Version file');

if (fileExists('VERSION')) {
  const version = readFile('VERSION').trim();
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    pass(`VERSION is valid semver: ${version}`);
  } else {
    fail(`VERSION is not valid semver: "${version}"`);
  }
} else {
  fail('VERSION file missing');
}

// ── 11. HEADLESS RUNNER (modes/runner.mjs) ──────────────────────

console.log('\n11. Headless runner (modes/runner.mjs)');

// 11a. Syntax of the runner + every provider adapter
const runnerFiles = [
  'modes/runner.mjs',
  'modes/providers/index.mjs',
  'modes/providers/stub.mjs',
  'modes/providers/gemini.mjs',
  'modes/providers/anthropic.mjs',
  'modes/providers/openai.mjs',
  'modes/providers/ollama.mjs',
];
for (const f of runnerFiles) {
  if (!fileExists(f)) { fail(`${f} missing`); continue; }
  const result = run('node', ['--check', f]);
  if (result !== null) pass(`${f} syntax OK`);
  else fail(`${f} has syntax errors`);
}

// 11b. --help exits 0
const helpOut = run('node', ['modes/runner.mjs', '--help']);
if (helpOut !== null && helpOut.includes('--mode')) {
  pass('modes/runner.mjs --help exits 0');
} else {
  fail('modes/runner.mjs --help did not produce expected output');
}

// 11b2. CLI can execute and write a report with the offline stub provider
const runnerOutPath = `/tmp/career-ops-runner-test-${process.pid}.md`;
try { if (existsSync(runnerOutPath)) unlinkSync(runnerOutPath); } catch {}
const runnerCliOut = run('node', [
  'modes/runner.mjs',
  '--mode', 'oferta',
  '--jd', 'examples/sample-jd.txt',
  '--cv', 'examples/cv-example.md',
  '--out', runnerOutPath,
], { env: { ...process.env, STUB_LLM: '1' } });
if (
  runnerCliOut &&
  runnerCliOut.includes('Report saved') &&
  existsSync(runnerOutPath) &&
  readFileSync(runnerOutPath, 'utf-8').includes('# Evaluation: StubCo — Stub Engineer')
) {
  pass('modes/runner.mjs CLI writes a stub report');
} else {
  fail('modes/runner.mjs CLI did not write expected stub report');
}
try { if (existsSync(runnerOutPath)) unlinkSync(runnerOutPath); } catch {}

// 11c. CLI dispatcher exposes `runner` subcommand
const cliHelp = run('node', ['bin/career-ops.mjs', '--help']);
if (cliHelp && /\brunner\b/.test(cliHelp)) {
  pass('career-ops CLI exposes `runner` subcommand');
} else {
  fail('career-ops --help does not list `runner` subcommand');
}

// 11d. Stub provider end-to-end (no network, no API keys)
try {
  const { runMode } = await import(pathToFileURL(join(ROOT, 'modes', 'runner.mjs')).href);
  const res = await runMode({
    mode: 'oferta',
    inputs: { jd: 'Senior AI Engineer at Acme. Remote.', cv: '## Skills\nPython, ML.' },
    provider: 'stub',
    save: false,
  });
  if (res?.text && res.summary?.score === '4.0' && res.summary?.company === 'StubCo') {
    pass('runMode({ provider: "stub" }) returns deterministic output');
  } else {
    fail(`stub runMode returned unexpected result: ${JSON.stringify(res?.summary)}`);
  }
} catch (e) {
  fail(`stub runMode threw: ${e.message}`);
}

// 11e. Unknown provider rejected
try {
  const { getProvider } = await import(pathToFileURL(join(ROOT, 'modes', 'providers', 'index.mjs')).href);
  let threw = false;
  try { getProvider('not-a-real-provider'); } catch { threw = true; }
  if (threw) pass('getProvider() rejects unknown provider names');
  else fail('getProvider() should throw on unknown provider');
} catch (e) {
  fail(`providers/index import failed: ${e.message}`);
}

// ── 12. REVIEW QUEUE (commands/review.mjs) ──────────────────────

console.log('\n12. Review queue (commands/review.mjs)');

const reviewFile = 'commands/review.mjs';
if (!fileExists(reviewFile)) {
  fail(`${reviewFile} missing`);
} else {
  const r1 = run('node', ['--check', reviewFile]);
  if (r1 !== null) pass(`${reviewFile} syntax OK`); else fail(`${reviewFile} syntax error`);

  // CLI exposes `review`
  const cliHelp2 = run('node', ['bin/career-ops.mjs', '--help']);
  if (cliHelp2 && /\breview\b/.test(cliHelp2)) pass('career-ops CLI exposes `review` subcommand');
  else fail('career-ops --help does not list `review`');

  // enqueueIfQualified contract: below threshold → null, above → entry
  try {
    const { enqueueIfQualified } = await import(pathToFileURL(join(ROOT, reviewFile)).href);
    const low  = await enqueueIfQualified({ company: '__test_low',  role: 'r', url: 'u', report: 'rep', score: '2.0', threshold: 4.0 });
    const high = await enqueueIfQualified({ company: '__test_high', role: 'r', url: 'u', report: 'rep', score: '4.7', threshold: 4.0 });
    if (low === null && high && high.id?.startsWith('q-')) {
      pass('enqueueIfQualified honors threshold and returns stable id');
    } else {
      fail(`enqueueIfQualified misbehaved: low=${JSON.stringify(low)} high=${JSON.stringify(high)}`);
    }
    // Idempotent re-enqueue
    const again = await enqueueIfQualified({ company: '__test_high', role: 'r', url: 'u', report: 'rep', score: '4.7', threshold: 4.0 });
    if (again?.id === high.id) pass('enqueueIfQualified is idempotent on (company, role, url)');
    else fail('enqueueIfQualified produced a different id on repeat');

    // Tidy up our fixture rows so they don't accumulate in the real queue.
    const qPath = join(ROOT, 'data', 'review-queue.md');
    if (existsSync(qPath)) {
      const cleaned = readFileSync(qPath, 'utf-8')
        .split('\n')
        .filter(l => !/__test_(low|high)/.test(l))
        .join('\n');
      const { writeFileSync } = await import('fs');
      writeFileSync(qPath, cleaned, 'utf-8');
    }
  } catch (e) {
    fail(`review module import/exec failed: ${e.message}`);
  }
}

// ── 13. BROWSER APPLICATION ASSISTANT (Task 5B) ────────────────

console.log('\n13. Browser application assistant (application-browser-assistant.mjs)');

const browserApplyFile = 'application-browser-assistant.mjs';
const browserApplySyntax = run('node', ['--check', browserApplyFile]);
if (browserApplySyntax !== null) pass(`${browserApplyFile} syntax OK`);
else fail(`${browserApplyFile} has syntax errors`);

try {
  const browserApply = await import(pathToFileURL(join(ROOT, browserApplyFile)).href);
  const fixture = readFile('examples/apply-form-fixture.html');
  const fields = browserApply.detectFieldsFromHtml(fixture);
  const proposals = browserApply.proposeAnswers(fields, {
    profile: {
      candidate: { full_name: 'Jane Smith', email: 'jane@example.com', linkedin: 'linkedin.com/in/jane' },
      application_answers: {
        salary_expectations: '$150K-$200K USD',
        notice_period: '30 days',
        source: 'LinkedIn',
        london_relocation: 'No — remote preferred',
        confirm_no_ai_interview_tools: true,
      },
    },
    report: { company: 'FixtureCo', role: 'AI Engineer' },
  });
  const submit = proposals.find(p => p.label === 'Submit application');
  const salary = proposals.find(p => p.label === 'Expected salary');
  const notice = proposals.find(p => p.label === 'What is your current notice period?');
  const visa = proposals.find(p => p.label === 'Do you require visa sponsorship?');
  const email = proposals.find(p => p.label === 'Email');
  const radioSource = proposals.find(p => p.type === 'radio' && /linkedin/i.test(p.value || p.optionLabel || ''));
  const customSource = proposals.find(p => p.kind === 'custom-select');
  const relocation = proposals.find(p => /London office/.test(p.label || ''));
  const relocationSelect = proposals.find(p => p.id === 'relocation_select');
  const aiTerms = proposals.find(p => p.id === 'ai_terms');
  const next = proposals.find(p => p.label === 'Continue');
  if (fields.length >= 15 && submit?.action === 'stop' && salary?.action === 'fill' && notice?.action === 'fill' && relocation?.action === 'fill' && relocationSelect?.action === 'fill' && relocationSelect?.value === 'Remote' && aiTerms?.action === 'check' && visa?.action === 'skip' && email?.value === 'jane@example.com' && radioSource?.action === 'check' && customSource?.action === 'fill' && next?.action === 'next') {
    pass('browser assistant detects fixture fields, fills configured sensitive answers/radios/custom selects, advances safe next, and stops at submit');
  } else {
    fail(`browser assistant proposals unexpected: ${JSON.stringify({ submit, salary, notice, visa, email, radioSource, customSource, relocation, relocationSelect, aiTerms, next })}`);
  }
  if (readFile(browserApplyFile).includes('clickSafeNext') && browserApply.isFinalSubmitLabel('Submit application') && !browserApply.isFinalSubmitLabel('Continue')) {
    pass('browser assistant only clicks safe navigation controls and still detects final submit controls');
  } else {
    fail('browser assistant safe-next/final-submit detection failed');
  }
} catch (e) {
  fail(`browser assistant module tests failed: ${e.message}`);
}

const auditPath = join(ROOT, 'output', 'applications', `draft-unknown-${new Date().toISOString().slice(0, 10)}.md`);
try { if (existsSync(auditPath)) unlinkSync(auditPath); } catch {}
const browserDryRun = run('node', ['apply-assistant.mjs', '--browser', '--fixture', 'examples/apply-form-fixture.html', '--dry-run']);
if (browserDryRun && browserDryRun.includes('Detected') && browserDryRun.includes('Submit application') && browserDryRun.includes('never clicked') && existsSync(auditPath)) {
  pass('career-ops apply --browser --dry-run detects fixture and writes audit without submitting');
} else {
  fail('apply --browser --dry-run did not produce expected fixture output/audit');
}
try { if (existsSync(auditPath)) unlinkSync(auditPath); } catch {}

// ── SUMMARY ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);

if (failed > 0) {
  console.log('🔴 TESTS FAILED — do NOT push/merge until fixed\n');
  process.exit(1);
} else if (warnings > 0) {
  console.log('🟡 Tests passed with warnings — review before pushing\n');
  process.exit(0);
} else {
  console.log('🟢 All tests passed — safe to push/merge\n');
  process.exit(0);
}
