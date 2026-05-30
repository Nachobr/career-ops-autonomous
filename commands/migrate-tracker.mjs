import { existsSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { pathToFileURL } from 'url';
import {
  closeDb,
  openDb,
  parseTrackerMarkdown,
  rowCount,
  syncApplications,
} from '../lib/tracker-db.mjs';

const ROOT = resolve(dirname(new URL('../package.json', import.meta.url).pathname));
const APPS_FILE = join(ROOT, 'data', 'applications.md');

function printHelp() {
  console.log(`career-ops migrate-tracker — import data/applications.md into SQLite

Usage:
  career-ops migrate-tracker [--db <path>] [--dry-run]
  node commands/migrate-tracker.mjs [--db <path>] [--dry-run]

Flags:
  --db <path>  Override data/applications.db.
  --dry-run    Parse and report counts without writing.
  -h, --help   Show this help.
`);
}

function parseArgs(argv = []) {
  const opts = { db: null, dryRun: false, help: false, invalid: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--db') {
      opts.db = argv[++i] || null;
      if (!opts.db) opts.invalid = '--db requires a path';
    } else if (arg.startsWith('--db=')) {
      opts.db = arg.slice('--db='.length);
    } else {
      opts.invalid = arg;
    }
  }
  return opts;
}

export default async function migrateTracker(argv) {
  const opts = parseArgs(argv || []);
  if (opts.help) { printHelp(); return 0; }
  if (opts.invalid) {
    console.error(`career-ops migrate-tracker: invalid argument ${opts.invalid}`);
    return 2;
  }
  if (!existsSync(APPS_FILE)) {
    console.error('career-ops migrate-tracker: data/applications.md not found');
    return 1;
  }

  const rows = parseTrackerMarkdown(readFileSync(APPS_FILE, 'utf-8'));
  if (opts.dryRun) {
    console.log(`${rows.length} rows parsed (dry-run, no writes).`);
    return 0;
  }

  const db = openDb(opts.db || undefined);
  try {
    const existing = new Set(db.prepare('SELECT id FROM applications').all().map((row) => row.id));
    const inserted = rows.filter((row) => !existing.has(row.id)).length;
    const updated = rows.length - inserted;
    syncApplications(db, rows);
    console.log(`${rows.length} rows imported (${inserted} inserted, ${updated} updated). Total: ${rowCount(db)}.`);
    return 0;
  } finally {
    closeDb(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateTracker(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
