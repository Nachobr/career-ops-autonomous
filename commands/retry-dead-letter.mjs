import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { readDeadLetter, writeDeadLetter, DEAD_LETTER_PATH } from '../lib/dead-letter.mjs';

const ROOT = resolve(dirname(new URL('../package.json', import.meta.url).pathname));
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const REQUEUE_SOURCES = new Set(['scrape', 'scan', 'llm']);

function printHelp() {
  console.log(`career-ops retry-dead-letter — reprocess failed items from the dead-letter queue

Usage:
  career-ops retry-dead-letter [--list | --clear | --dry-run]

Flags:
  --list      Print queued failures and exit without changes.
  --clear     Empty data/dead-letter.ndjson and exit.
  --dry-run   Print what would be requeued without modifying files.
  -h, --help  Show this help.
`);
}

function parseArgs(argv = []) {
  const opts = { help: false, list: false, clear: false, dryRun: false, invalid: null };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--clear') opts.clear = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else opts.invalid = arg;
  }
  return opts;
}

function ensurePipeline() {
  mkdirSync(dirname(PIPELINE_PATH), { recursive: true });
  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');
  }
}

function isQueued(text, url) {
  return text.split('\n').some((line) => line.includes(url));
}

function appendPending(url) {
  ensurePipeline();
  let text = readFileSync(PIPELINE_PATH, 'utf-8');
  if (isQueued(text, url)) return false;
  const line = `- [ ] ${url}`;
  if (/##\s+Pendientes/i.test(text)) {
    text = text.replace(/(##\s+Pendientes[^\n]*\n)/i, `$1${line}\n`);
  } else {
    if (!text.endsWith('\n')) text += '\n';
    text += `\n## Pendientes\n${line}\n`;
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
  return true;
}

function printList(entries) {
  if (entries.length === 0) {
    console.log(`Dead-letter queue is empty (${DEAD_LETTER_PATH})`);
    return;
  }
  const rows = entries.map((entry, i) => ({
    i: String(i + 1),
    ts: entry.ts || '',
    source: entry.source || '',
    attempts: String(entry.attempts || ''),
    url: entry.url || '',
    error: entry.error || '',
  }));
  const cols = ['i', 'source', 'attempts', 'ts', 'url', 'error'];
  const widths = Object.fromEntries(cols.map((col) => [col, Math.min(60, Math.max(col.length, ...rows.map((row) => row[col].length)))]));
  console.log(`Dead-letter queue (${DEAD_LETTER_PATH})`);
  console.log(cols.map((col) => col.padEnd(widths[col])).join('  '));
  console.log(cols.map((col) => '-'.repeat(widths[col])).join('  '));
  for (const row of rows) {
    console.log(cols.map((col) => row[col].slice(0, widths[col]).padEnd(widths[col])).join('  '));
  }
}

export default async function retryDeadLetter(argv) {
  const opts = parseArgs(argv || []);
  if (opts.help) { printHelp(); return 0; }
  if (opts.invalid) {
    console.error(`career-ops retry-dead-letter: unknown flag ${opts.invalid}`);
    return 2;
  }

  const entries = readDeadLetter();
  if (opts.list) {
    printList(entries);
    return 0;
  }
  if (opts.clear) {
    writeDeadLetter([]);
    console.log(`Cleared dead-letter queue (${DEAD_LETTER_PATH}).`);
    return 0;
  }

  let requeued = 0;
  let skipped = 0;
  const remaining = [];

  for (const entry of entries) {
    if (REQUEUE_SOURCES.has(entry.source) && entry.url) {
      if (opts.dryRun) {
        console.log(`would requeue ${entry.source}: ${entry.url}`);
        requeued++;
      } else {
        const added = appendPending(entry.url);
        console.log(`${added ? 'requeued' : 'already queued'} ${entry.source}: ${entry.url}`);
        requeued++;
      }
      continue;
    }

    if (entry.source === 'pdf') {
      console.log('pdf failure: re-run `career-ops pdf` with the original HTML/PDF paths.');
    } else {
      console.log(`skipped ${entry.source || 'unknown'}: missing requeueable URL`);
    }
    skipped++;
    remaining.push(entry);
  }

  if (!opts.dryRun) writeDeadLetter(remaining);
  const remainingCount = opts.dryRun ? entries.length : remaining.length;
  console.log(`${requeued} requeued, ${skipped} skipped, ${remainingCount} remaining`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  retryDeadLetter(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
