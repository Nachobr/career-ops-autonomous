#!/usr/bin/env node

import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TARGETS = join(ROOT, 'data', 'apply-targets.md');
const BIN = join(ROOT, 'bin', 'career-ops.mjs');

function parseRows() {
  if (!existsSync(TARGETS)) throw new Error('data/apply-targets.md not found. Regenerate it first.');
  return readFileSync(TARGETS, 'utf-8').split('\n')
    .filter(l => l.startsWith('| q-'))
    .map(line => {
      const c = line.split('|').map(s => s.trim());
      return { id: c[1], score: c[2], company: c[3], role: c[4], status: c[5], report: c[6], url: c[7], command: c[8] };
    });
}

function reportNumFromLink(report = '') {
  return String(report || '').match(/\[(\d{3})\]/)?.[1]
    || String(report || '').match(/reports\/(\d{3})-/)?.[1]
    || '';
}

function reportPathFromLink(report = '') {
  const m = String(report || '').match(/\((reports\/[^)]+)\)/) || String(report || '').match(/(reports\/\S+\.md)/);
  return m ? join(ROOT, m[1]) : '';
}

function normalizeUrl(url = '') {
  return String(url || '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
}

function words(s = '') {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(w => w.length > 2);
}

function findBestReport(row) {
  const linkedPath = reportPathFromLink(row.report);
  const linkedNum = reportNumFromLink(row.report);
  if (linkedNum && linkedPath && existsSync(linkedPath)) return linkedNum;
  const reportsDir = join(ROOT, 'reports');
  if (!existsSync(reportsDir)) return '';
  const files = readdirSync(reportsDir).filter(f => f.endsWith('.md'));
  const wantedUrl = normalizeUrl(row.url);
  if (wantedUrl) {
    for (const f of files) {
      const body = readFileSync(join(reportsDir, f), 'utf-8');
      const url = body.match(/^\*\*URL:\*\*\s*(\S+)/m)?.[1] || '';
      if (normalizeUrl(url) === wantedUrl) return f.match(/^(\d{3})-/)?.[1] || '';
    }
  }
  const companyWords = words(row.company);
  const roleWords = words(row.role);
  const scored = files.map(f => {
    const hay = f.toLowerCase();
    const score = companyWords.filter(w => hay.includes(w)).length * 3 + roleWords.filter(w => hay.includes(w)).length;
    return { f, score };
  }).filter(x => x.score >= Math.max(3, Math.min(6, companyWords.length * 3))).sort((a, b) => b.score - a.score);
  return scored[0]?.f.match(/^(\d{3})-/)?.[1] || '';
}

function printHelp() {
  console.log(`career-ops apply-targets — use data/apply-targets.md

Usage:
  career-ops apply-targets list [--all]
  career-ops apply-targets next [--include-cloudflare] [--llm-answer-tokens N] [--debug]

By default, next opens only rows marked reachable. With --include-cloudflare,
it opens the first row that has a URL even if human verification is expected.
The assistant still never submits applications.`);
}

function cmdList(argv) {
  const all = argv.includes('--all');
  const rows = parseRows().filter(r => all || /reachable/.test(r.status));
  if (!rows.length) {
    console.log(all ? 'No apply targets found.' : 'No reachable apply targets found. Use --all to see blocked/stale rows.');
    return 0;
  }
  for (const r of rows) console.log(`${r.id}\t${r.status}\t${r.company}\t${r.role}\t${r.url}`);
  return 0;
}

function cmdNext(argv) {
  const includeCloudflare = argv.includes('--include-cloudflare');
  const tokenIdx = argv.indexOf('--llm-answer-tokens');
  const tokens = tokenIdx !== -1 && argv[tokenIdx + 1] ? argv[tokenIdx + 1] : '300';
  const debug = argv.includes('--debug');
  const rows = parseRows();
  const eligible = (r) => r.url && r.url !== '-' && !/no-url|bad-fit|skip|rejected/i.test(r.status);
  const row = rows.find(r => /reachable/.test(r.status) && eligible(r))
    || (includeCloudflare ? rows.find(r => eligible(r)) : null);
  if (!row) {
    console.log('No reachable targets in data/apply-targets.md. Regenerate targets or pass --include-cloudflare for manual-verification pages.');
    return 1;
  }
  const reportNum = findBestReport(row);
  const args = [BIN, 'review', 'approve', row.id, '--browser', '--url', row.url];
  if (reportNum) args.push('--report', reportNum);
  args.push('--llm-answer-tokens', tokens);
  if (debug) args.push('--debug');
  console.log(`Opening ${row.id}: ${row.company} — ${row.role}`);
  if (reportNum) console.log(`Using report ${reportNum} for context/PDF binding.`);
  else console.log('No matching report found; free-text context and CV upload may be limited.');
  if (!/reachable/.test(row.status)) console.log(`Note: status is ${row.status}; you may need to pass human verification manually.`);
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  return new Promise(resolve => {
    child.on('exit', code => resolve(code ?? 0));
    child.on('error', err => { console.error(err.message); resolve(1); });
  });
}

export default async function main(argv = []) {
  const sub = argv[0] || 'list';
  const rest = argv.slice(1);
  try {
    if (sub === '--help' || sub === '-h' || sub === 'help') { printHelp(); return 0; }
    if (sub === 'list') return cmdList(rest);
    if (sub === 'next') return await cmdNext(rest);
    console.error(`Unknown apply-targets subcommand: ${sub}`);
    printHelp();
    return 2;
  } catch (e) {
    console.error(`career-ops apply-targets: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code ?? 0));
}
