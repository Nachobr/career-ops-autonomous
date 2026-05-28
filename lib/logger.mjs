import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

const ROOT = resolve(dirname(new URL('../package.json', import.meta.url).pathname));
const DEFAULT_LOG_DIR = join(ROOT, 'data', 'logs');

function safePart(value) {
  return String(value || 'run')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

export function getDefaultLogPath(runIdOrDate = process.env.CAREER_OPS_RUN_ID || new Date().toISOString()) {
  const date = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = safePart(runIdOrDate);
  return join(DEFAULT_LOG_DIR, `run-${date}-${runId}.ndjson`);
}

export function rotateLogs(dir = DEFAULT_LOG_DIR, keep = 50) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^run-.*\.ndjson$/.test(f))
    .sort();
  const remove = files.slice(0, Math.max(0, files.length - keep));
  for (const f of remove) {
    try { unlinkSync(join(dir, f)); } catch {}
  }
  return remove;
}

function updateLatest(file) {
  const latest = join(dirname(file), 'latest.ndjson');
  try { unlinkSync(latest); } catch {}
  try {
    symlinkSync(basename(file), latest);
  } catch {
    try { copyFileSync(file, latest); }
    catch { writeFileSync(latest, `${file}\n`, 'utf-8'); }
  }
}

export function createLogger({ runId = process.env.CAREER_OPS_RUN_ID || safePart(new Date().toISOString()), file = null, cmd = null } = {}) {
  const logFile = file || getDefaultLogPath(runId);
  mkdirSync(dirname(logFile), { recursive: true });
  rotateLogs(dirname(logFile));
  updateLatest(logFile);

  function write(level, msg, meta = {}) {
    const line = {
      ts: new Date().toISOString(),
      level,
      runId,
      cmd,
      msg,
      ...meta,
    };
    appendFileSync(logFile, `${JSON.stringify(line)}\n`, 'utf-8');
    updateLatest(logFile);
    return line;
  }

  return {
    runId,
    file: logFile,
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    event: (name, meta = {}) => write(meta.level || 'info', name, { ...meta, event: name }),
  };
}
