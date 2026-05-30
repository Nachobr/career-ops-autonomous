import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const ROOT = resolve(dirname(new URL('../package.json', import.meta.url).pathname));
const SOURCES = new Set(['scrape', 'llm', 'pdf', 'scan']);

export const DEAD_LETTER_PATH = process.env.CAREER_OPS_DEAD_LETTER
  ? resolve(ROOT, process.env.CAREER_OPS_DEAD_LETTER)
  : join(ROOT, 'data', 'dead-letter.ndjson');

function shortError(error) {
  return String(error?.message || error || 'unknown error')
    .split('\n')[0]
    .slice(0, 300);
}

function normalizeAttempts(attempts) {
  const n = Number(attempts);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

export function recordDeadLetter({ source, url, error, attempts, meta = {} }) {
  if (!SOURCES.has(source)) throw new Error(`invalid dead-letter source: ${source}`);
  mkdirSync(dirname(DEAD_LETTER_PATH), { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    source,
    url: url ?? null,
    error: shortError(error),
    attempts: normalizeAttempts(attempts),
    runId: process.env.CAREER_OPS_RUN_ID || null,
    meta: meta && typeof meta === 'object' ? meta : {},
  };
  appendFileSync(DEAD_LETTER_PATH, `${JSON.stringify(entry)}\n`, 'utf-8');
  return entry;
}

export function readDeadLetter() {
  if (!existsSync(DEAD_LETTER_PATH)) return [];
  return readFileSync(DEAD_LETTER_PATH, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; }
      catch { return []; }
    });
}

export function writeDeadLetter(entries) {
  mkdirSync(dirname(DEAD_LETTER_PATH), { recursive: true });
  const lines = (entries || []).map((entry) => JSON.stringify(entry)).join('\n');
  writeFileSync(DEAD_LETTER_PATH, lines ? `${lines}\n` : '', 'utf-8');
}
