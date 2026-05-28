#!/usr/bin/env node

/**
 * doctor.mjs — Setup validation for career-ops
 * Checks all prerequisites and prints a pass/fail checklist.
 */

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

// ANSI colors (only on TTY)
const isTTY = process.stdout.isTTY;
const green = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0]);
  if (major >= 20) {
    return { pass: true, label: `Node.js >= 20 (v${process.versions.node})` };
  }
  return {
    pass: false,
    label: `Node.js >= 20 (found v${process.versions.node})`,
    fix: 'Install Node.js 20 or later from https://nodejs.org',
  };
}

function checkDependencies() {
  if (existsSync(join(projectRoot, 'node_modules'))) {
    return { pass: true, label: 'Dependencies installed' };
  }
  return {
    pass: false,
    label: 'Dependencies not installed',
    fix: 'Run: npm install',
  };
}

async function checkPlaywright() {
  try {
    const { chromium } = await import('playwright');
    const execPath = chromium.executablePath();
    if (existsSync(execPath)) {
      return { pass: true, label: 'Playwright chromium installed' };
    }
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx playwright install chromium',
    };
  } catch {
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx playwright install chromium',
    };
  }
}

function checkCv() {
  if (existsSync(join(projectRoot, 'cv.md'))) {
    return { pass: true, label: 'cv.md found' };
  }
  return {
    pass: false,
    label: 'cv.md not found',
    fix: [
      'Create cv.md in the project root with your CV in markdown',
      'See examples/ for reference CVs',
    ],
  };
}

function checkProfile() {
  if (existsSync(join(projectRoot, 'config', 'profile.yml'))) {
    return { pass: true, label: 'config/profile.yml found' };
  }
  return {
    pass: false,
    label: 'config/profile.yml not found',
    fix: [
      'Run: cp config/profile.example.yml config/profile.yml',
      'Then edit it with your details',
    ],
  };
}

function checkModeProfile() {
  if (existsSync(join(projectRoot, 'modes', '_profile.md'))) {
    return { pass: true, label: 'modes/_profile.md found' };
  }
  return {
    pass: false,
    label: 'modes/_profile.md not found',
    fix: 'Run: cp modes/_profile.template.md modes/_profile.md',
  };
}

function checkPortals() {
  if (existsSync(join(projectRoot, 'portals.yml'))) {
    return { pass: true, label: 'portals.yml found' };
  }
  return {
    pass: false,
    label: 'portals.yml not found',
    fix: [
      'Run: cp templates/portals.example.yml portals.yml',
      'Then customize with your target companies',
    ],
  };
}

function checkFonts() {
  const fontsDir = join(projectRoot, 'fonts');
  if (!existsSync(fontsDir)) {
    return {
      pass: false,
      label: 'fonts/ directory not found',
      fix: 'The fonts/ directory is required for PDF generation',
    };
  }
  try {
    const files = readdirSync(fontsDir);
    if (files.length === 0) {
      return {
        pass: false,
        label: 'fonts/ directory is empty',
        fix: 'The fonts/ directory must contain font files for PDF generation',
      };
    }
  } catch {
    return {
      pass: false,
      label: 'fonts/ directory not readable',
      fix: 'Check permissions on the fonts/ directory',
    };
  }
  return { pass: true, label: 'Fonts directory ready' };
}

function checkAutoDir(name) {
  const dirPath = join(projectRoot, name);
  if (existsSync(dirPath)) {
    return { pass: true, label: `${name}/ directory ready` };
  }
  try {
    mkdirSync(dirPath, { recursive: true });
    return { pass: true, label: `${name}/ directory ready (auto-created)` };
  } catch {
    return {
      pass: false,
      label: `${name}/ directory could not be created`,
      fix: `Run: mkdir ${name}`,
    };
  }
}

async function loadProfile() {
  const path = join(projectRoot, 'config', 'profile.yml');
  if (!existsSync(path)) return {};
  try {
    const yaml = (await import('js-yaml')).default;
    return yaml.load(readFileSync(path, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function checkLlm(profile) {
  if (process.env.STUB_LLM === '1') return { pass: true, label: 'LLM provider configured (stub)' };
  if (process.env.LOCAL_LLM_BASE_URL) {
    return { pass: true, label: 'LLM provider configured (LOCAL_LLM_BASE_URL)' };
  }
  const provider = profile?.llm?.provider || 'gemini';
  const envByProvider = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    ollama: null,
    stub: null,
  };
  const envName = envByProvider[provider];
  if (provider === 'ollama' || provider === 'stub') {
    return { pass: true, label: `LLM provider configured (${provider})` };
  }
  if (envName && process.env[envName]) {
    return { pass: true, label: `LLM provider configured (${provider})` };
  }
  return {
    pass: false,
    label: `LLM provider missing credentials (${provider})`,
    fix: `Run: career-ops login --provider ${provider} or configure LOCAL_LLM_BASE_URL`,
  };
}

function pidAlive(pid) {
  if (!pid || !Number.isNaN(Number(pid)) === false) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function checkLock() {
  const lockPath = join(projectRoot, 'data', '.run.lock');
  if (!existsSync(lockPath)) return { pass: true, label: 'No active run lock' };
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (lock.pid && String(lock.pid) === process.env.CAREER_OPS_RUN_LOCK_PID) {
      return { pass: true, label: 'Run lock owned by current career-ops run' };
    }
    if (lock.pid && pidAlive(lock.pid)) {
      return {
        pass: false,
        label: `Active run lock found (pid ${lock.pid})`,
        fix: 'Wait for the current run to finish, or remove data/.run.lock if it is stale',
      };
    }
  } catch { /* malformed lock is stale */ }
  try { unlinkSync(lockPath); } catch {}
  return { pass: true, label: 'Stale run lock cleared' };
}

function checkTracker() {
  const appsPath = join(projectRoot, 'data', 'applications.md');
  if (!existsSync(appsPath)) return { pass: true, label: 'Tracker not found yet (ok for first run)' };
  const text = readFileSync(appsPath, 'utf-8');
  const rows = text.split('\n').filter(line => /^\|\s*\d+\s*\|/.test(line));
  const bad = rows.filter(line => line.split('|').length < 9);
  if (bad.length) {
    return { pass: false, label: `Tracker has ${bad.length} malformed row(s)`, fix: 'Run: career-ops verify' };
  }
  return { pass: true, label: `Tracker parses (${rows.length} rows)` };
}

function checkDiskSpace() {
  try {
    const out = execFileSync('df', ['-k', projectRoot], { encoding: 'utf-8' }).trim().split('\n').at(-1);
    const parts = out.trim().split(/\s+/);
    const availableKb = Number(parts[3]);
    const availableMb = availableKb / 1024;
    if (availableMb >= 500) return { pass: true, label: `Disk space >= 500MB (${availableMb.toFixed(0)}MB free)` };
    return { pass: false, label: `Disk space low (${availableMb.toFixed(0)}MB free)`, fix: 'Free at least 500MB before running the pipeline' };
  } catch {
    return { pass: true, label: 'Disk space check unavailable (skipped)' };
  }
}

function normalizeForJson(result) {
  return {
    name: result.name || result.label,
    ok: Boolean(result.pass),
    message: result.label,
    fix: result.fix || null,
  };
}

async function main() {
  const json = process.argv.includes('--json');
  const profile = await loadProfile();

  const checks = [
    checkNodeVersion(),
    checkDependencies(),
    await checkPlaywright(),
    checkCv(),
    checkProfile(),
    checkModeProfile(),
    checkPortals(),
    checkLlm(profile),
    checkTracker(),
    checkLock(),
    checkDiskSpace(),
    checkFonts(),
    checkAutoDir('data'),
    checkAutoDir('output'),
    checkAutoDir('reports'),
  ];

  let failures = 0;

  if (json) {
    const out = { ok: checks.every(result => result.pass), checks: checks.map(normalizeForJson) };
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 1);
  }

  console.log('\ncareer-ops doctor');
  console.log('================\n');

  for (const result of checks) {
    if (result.pass) {
      console.log(`${green('✓')} ${result.label}`);
    } else {
      failures++;
      console.log(`${red('✗')} ${result.label}`);
      const fixes = Array.isArray(result.fix) ? result.fix : [result.fix];
      for (const hint of fixes) {
        console.log(`  ${dim('→ ' + hint)}`);
      }
    }
  }

  console.log('');
  if (failures > 0) {
    console.log(`Result: ${failures} issue${failures === 1 ? '' : 's'} found. Fix them and run \`npm run doctor\` again.`);
    process.exit(1);
  } else {
    console.log('Result: All checks passed. You\'re ready to go! Run `career-ops run --dry-run` to preview the autonomous pipeline.');
    console.log('');
    console.log('Join the community: https://discord.gg/8pRpHETxa4');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('doctor.mjs failed:', err.message);
  process.exit(1);
});
