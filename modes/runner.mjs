#!/usr/bin/env node
/**
 * modes/runner.mjs — Headless executor for modes/*.md prompts
 *
 * Loads modes/_shared.md + modes/_profile.md + modes/<mode>.md, substitutes
 * {{placeholders}} from `inputs`, calls the configured LLM provider, and
 * (optionally) writes the result to reports/ with the canonical
 * 3-digit-prefixed filename.
 *
 * Implements Task 2 of docs/AUTONOMOUS_CLI_TODO.md.
 *
 * Programmatic API:
 *   import { runMode } from './modes/runner.mjs';
 *   await runMode({
 *     mode: 'oferta',
 *     inputs: { jd, cv, company, role },
 *     provider: 'gemini',          // optional override
 *     model: 'gemini-2.0-flash',   // optional override
 *     save: true,                  // write reports/NNN-...md
 *     outPath: null,               // explicit override; disables auto-numbering
 *   })
 *   -> { text, usage, reportPath, summary }
 *
 * CLI:
 *   node modes/runner.mjs --mode oferta \
 *     --jd ./jds/example.txt --cv ./cv.md \
 *     --out reports/123-example.md
 *
 *   node modes/runner.mjs --mode oferta \
 *     --jd examples/sample-jd.txt --cv examples/cv-example.md
 *
 * Env:
 *   STUB_LLM=1   force the deterministic stub provider (used by tests)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { dirname, join, resolve, basename } from 'path';
import { fileURLToPath } from 'url';

// Optional .env support; never required.
try {
  const { config } = await import('dotenv');
  config({ quiet: true });
} catch { /* dotenv missing — that's fine */ }

import { getProvider, listProviders } from './providers/index.mjs';
import { withRetry } from '../lib/retry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PATHS = {
  shared:  join(ROOT, 'modes', '_shared.md'),
  profile: join(ROOT, 'modes', '_profile.md'),
  modes:   join(ROOT, 'modes'),
  cv:      join(ROOT, 'cv.md'),
  reports: join(ROOT, 'reports'),
  config:  join(ROOT, 'config', 'profile.yml'),
};

function retryLlmError(err) {
  // Providers flag transient failures (429 / 5xx / timeout / network) explicitly.
  if (err && err.retryable === true) return true;
  return /rate|timeout|ECONN|ETIMEDOUT|5\d\d|overloaded|429|truncat|incomplete|empty (llm )?response/i.test(String(err?.message || err || ''));
}

// Modes that produce a structured A–H evaluation report. For these we verify the
// model actually wrote a body (not just a header) before accepting the response.
const EVALUATION_MODES = /(^|\/)(oferta|angebot|offre|kyujin|is-ilani)$/;

// Guard against silently saving a truncated/empty response. A flaky LLM endpoint
// occasionally returns just a header (finish_reason=length, partial stream, etc.).
// Throwing a retryable error here lets withRetry get a clean response; if every
// attempt is incomplete the caller fails loudly into the dead-letter queue
// instead of writing a stub report.
function assertCompleteResponse({ text, finishReason }, mode) {
  const t = String(text || '').trim();
  if (!t) throw new Error('empty LLM response');
  if (finishReason && !/^(stop|end_turn|eos)$/i.test(finishReason)) {
    throw new Error(`LLM response truncated (finish_reason=${finishReason})`);
  }
  if (EVALUATION_MODES.test(mode)) {
    const body = t.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '');
    const hasBlocks = /(^|\n)#{1,3}\s*[A-H][\).]/.test(body)
      || /Role Summary|Match with CV|Resumen del rol|Übereinstimmung|Adéquation/i.test(body);
    if (!hasBlocks) {
      throw new Error('LLM response incomplete (evaluation body missing A–H blocks)');
    }
  }
}

function retryLog(err, attempt, delayMs) {
  const msg = String(err?.message || err || 'error').split('\n')[0];
  const hint = Number.isFinite(err?.retryAfterMs) ? ' (server Retry-After honored)' : '';
  console.warn(`  ↻ retry ${attempt} after ${delayMs}ms${hint}: ${msg}`);
}

// ── helpers ─────────────────────────────────────────────────────

function readFileSafe(path, label) {
  if (!existsSync(path)) {
    return { ok: false, content: `[${label} not found at ${path}]` };
  }
  return { ok: true, content: readFileSync(path, 'utf-8') };
}

async function loadLlmConfig() {
  // Best-effort load of config/profile.yml.llm. Never throws.
  // Falls back to { provider: 'gemini' } when missing.
  if (process.env.LOCAL_LLM_BASE_URL) {
    process.env.OPENAI_BASE_URL ||= process.env.LOCAL_LLM_BASE_URL.replace(/\/$/, '').endsWith('/v1')
      ? process.env.LOCAL_LLM_BASE_URL.replace(/\/$/, '')
      : `${process.env.LOCAL_LLM_BASE_URL.replace(/\/$/, '')}/v1`;
    process.env.OPENAI_API_KEY ||= process.env.LOCAL_LLM_API_KEY || 'none';
    return {
      provider: 'openai',
      model: process.env.LOCAL_LLM_MODEL || null,
      max_tokens: 4096,
      temperature: 0.3,
    };
  }
  const fallback = {
    provider: 'gemini',
    model: null,
    max_tokens: 4096,
    temperature: 0.3,
  };
  if (!existsSync(PATHS.config)) return fallback;
  try {
    // js-yaml is already a project dep
    const yaml = await import('js-yaml');
    const doc = yaml.default.load(readFileSync(PATHS.config, 'utf-8')) || {};
    const llm = doc.llm || {};
    return {
      provider: llm.provider || fallback.provider,
      model: llm.model || null,
      max_tokens: llm.max_tokens || fallback.max_tokens,
      temperature: llm.temperature ?? fallback.temperature,
    };
  } catch {
    return fallback;
  }
}

function substitute(template, inputs) {
  // Replace {{var}} with inputs[var]. Unknown placeholders are left in place
  // (so the LLM can see them and complain) but logged to stderr.
  const seen = new Set();
  const out = template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(inputs, key)) {
      seen.add(key);
      return String(inputs[key] ?? '');
    }
    return m;
  });
  return { text: out, seen: [...seen] };
}

function loadMode(mode) {
  const file = join(PATHS.modes, `${mode}.md`);
  if (!existsSync(file)) {
    throw new Error(`Mode "${mode}" not found at ${file}`);
  }
  return readFileSync(file, 'utf-8');
}

function buildSystemPrompt(mode, inputs) {
  const shared  = readFileSafe(PATHS.shared,  'modes/_shared.md').content;
  const profile = readFileSafe(PATHS.profile, 'modes/_profile.md').content;
  const modeBody = loadMode(mode);

  // Make _shared and _profile available as placeholders inside the mode body
  // (rarely needed, but cheap to support).
  const merged = [
    '════════════════════════════════════════════════════════════════',
    `MODE: ${mode}`,
    '════════════════════════════════════════════════════════════════',
    '',
    '## SYSTEM CONTEXT (modes/_shared.md)',
    shared,
    '',
    '## USER PROFILE (modes/_profile.md)',
    profile,
    '',
    `## MODE INSTRUCTIONS (modes/${mode}.md)`,
    modeBody,
    '',
    '## OPERATING RULES FOR THIS HEADLESS RUN',
    '1. You do NOT have access to web search, Playwright, or file-writing tools.',
    '   Generate the requested output based purely on the inputs provided below.',
    '2. End your response with a machine-readable summary block in this exact format:',
    '',
    '---SCORE_SUMMARY---',
    'COMPANY: <name or "Unknown">',
    'ROLE: <role title>',
    'SCORE: <decimal 1-5, e.g. 3.8>',
    'ARCHETYPE: <detected archetype>',
    'LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>',
    '---END_SUMMARY---',
    '',
  ].join('\n');

  const { text, seen } = substitute(merged, inputs);
  return { systemPrompt: text, seenPlaceholders: seen };
}

function buildUserPrompt(inputs) {
  // Conventional layout: pass the JD (or arbitrary main input) as the user turn,
  // plus a CV section if provided. All other inputs are embedded as a JSON
  // appendix so the model can reference them.
  const lines = [];
  if (inputs.jd) {
    lines.push('## JOB DESCRIPTION', String(inputs.jd).trim(), '');
  }
  if (inputs.cv) {
    lines.push('## CANDIDATE CV (cv.md)', String(inputs.cv).trim(), '');
  }
  const extra = { ...inputs };
  delete extra.jd;
  delete extra.cv;
  const keys = Object.keys(extra);
  if (keys.length) {
    lines.push('## ADDITIONAL INPUTS');
    for (const k of keys) {
      lines.push(`- ${k}: ${String(extra[k]).slice(0, 500)}`);
    }
  }
  if (!lines.length) {
    lines.push('Proceed with the mode instructions above.');
  }
  return lines.join('\n');
}

function parseSummary(text) {
  const m = text.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
  let block = m?.[1] || null;
  if (!block) {
    const candidates = [...text.matchAll(/(?:^|\n)((?:\s*(?:[-*]\s*)?\*{0,2}[A-Z][A-Z_ ]+\*{0,2}:\s*.+\n?){3,})/gi)];
    for (const c of candidates.reverse()) {
      if (/company\*{0,2}:/i.test(c[1]) && /role\*{0,2}:/i.test(c[1]) && /score\*{0,2}:/i.test(c[1])) {
        block = c[1];
        break;
      }
    }
  }
  if (!block) return null;
  const get = (key) => {
    const mm = block.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?\\*{0,2}${key}\\*{0,2}:\\s*(.+)`, 'i'));
    return mm ? mm[1].replace(/\s{2,}$/, '').trim() : null;
  };
  return {
    company:    get('COMPANY')    || 'Unknown',
    role:       get('ROLE')       || 'Unknown',
    score:      get('SCORE')      || '?',
    archetype:  get('ARCHETYPE')  || 'Unknown',
    legitimacy: get('LEGITIMACY') || 'Unknown',
  };
}

function nextReportNumber() {
  if (!existsSync(PATHS.reports)) return '001';
  const nums = readdirSync(PATHS.reports)
    .map(f => /^(\d{3})-/.exec(f))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10));
  if (!nums.length) return '001';
  return String(Math.max(...nums) + 1).padStart(3, '0');
}

function slugify(s) {
  return String(s || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function defaultReportPath(summary) {
  if (!existsSync(PATHS.reports)) mkdirSync(PATHS.reports, { recursive: true });
  const num = nextReportNumber();
  const today = new Date().toISOString().slice(0, 10);
  const slug = slugify(summary?.company);
  return join(PATHS.reports, `${num}-${slug}-${today}.md`);
}

function formatScore(score) {
  if (!score) return '?/5';
  const raw = String(score).trim();
  return /\/\s*5\b/.test(raw) ? raw : `${raw}/5`;
}

function displayProviderName(provider) {
  if (provider === 'openai' && process.env.LOCAL_LLM_BASE_URL) {
    const base = process.env.LOCAL_LLM_BASE_URL.toLowerCase();
    if (base.includes('ngrok')) return 'colab/ngrok';
    if (base.includes('localhost') || base.includes('127.0.0.1')) return 'local/openai-compatible';
    return 'custom/openai-compatible';
  }
  return provider;
}

function renderReportFile({ summary, text, provider, model, mode }) {
  const today = new Date().toISOString().slice(0, 10);
  const body = text.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim();
  const sourceUrl = summary?.url || summary?.sourceUrl || null;
  const providerLabel = displayProviderName(provider);
  const header = [
    `# Evaluation: ${summary?.company ?? 'Unknown'} — ${summary?.role ?? 'Unknown'}`,
    '',
    `**Date:** ${today}`,
    `**Archetype:** ${summary?.archetype ?? 'Unknown'}`,
    `**Score:** ${formatScore(summary?.score)}`,
    sourceUrl ? `**URL:** ${sourceUrl}` : null,
    `**Legitimacy:** ${summary?.legitimacy ?? 'Unknown'}`,
    `**PDF:** pending`,
    `**Tool:** ${providerLabel}${model ? ` (${model})` : ''}`,
    `**Mode:** ${mode}`,
    '',
    '---',
    '',
    body,
    '',
  ].filter(line => line !== null).join('\n');
  return header;
}

// ── public API ──────────────────────────────────────────────────

export async function runMode({
  mode,
  inputs = {},
  provider = null,
  model = null,
  maxTokens = null,
  temperature = null,
  save = false,
  outPath = null,
} = {}) {
  if (!mode) throw new Error('runMode: `mode` is required');

  const cfg = await loadLlmConfig();
  const providerName = process.env.STUB_LLM === '1'
    ? 'stub'
    : (provider || cfg.provider || 'gemini');
  const prov = getProvider(providerName);
  const effectiveModel = model || cfg.model || prov.DEFAULT_MODEL;
  const effectiveMaxTokens = maxTokens ?? cfg.max_tokens ?? 4096;
  const effectiveTemperature = temperature ?? cfg.temperature ?? 0.3;

  const { systemPrompt } = buildSystemPrompt(mode, inputs);
  const userPrompt = buildUserPrompt(inputs);

  const { text, usage } = await withRetry(async () => {
    const res = await prov.complete({
      system: systemPrompt,
      user: userPrompt,
      model: effectiveModel,
      maxTokens: effectiveMaxTokens,
      temperature: effectiveTemperature,
    });
    assertCompleteResponse(res, mode);
    return res;
  }, {
    // Overload-tolerant defaults (env-tunable): with baseMs=1000/factor=2 the
    // backoff is ~1s,2s,4s,8s (capped at maxMs), and a server Retry-After hint
    // overrides it when longer. Good for a busy NVIDIA NIM endpoint.
    attempts: Number(process.env.LLM_RETRY_ATTEMPTS) || 5,
    baseMs: Number(process.env.LLM_RETRY_BASE_MS) || 1000,
    maxMs: Number(process.env.LLM_RETRY_MAX_MS) || 30000,
    retryOn: retryLlmError,
    onRetry: retryLog,
  });

  const summary = parseSummary(text);
  if (summary && (inputs.url || inputs.sourceUrl)) {
    summary.url = inputs.url || inputs.sourceUrl;
  }

  let reportPath = null;
  if (save || outPath) {
    reportPath = outPath
      ? resolve(outPath)
      : defaultReportPath(summary);
    const dir = dirname(reportPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      reportPath,
      renderReportFile({ summary, text, provider: providerName, model: effectiveModel, mode }),
      'utf-8'
    );
  }

  return { text, usage, summary, reportPath, provider: providerName, model: effectiveModel };
}

// ── CLI ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { mode: null, jd: null, cv: null, out: null, provider: null, model: null,
                 maxTokens: null, temperature: null, save: null, inputs: {}, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help':         opts.help = true; break;
      case '--mode':         opts.mode = next(); break;
      case '--jd':           opts.jd = next(); break;
      case '--cv':           opts.cv = next(); break;
      case '--out':          opts.out = next(); break;
      case '--provider':     opts.provider = next(); break;
      case '--model':        opts.model = next(); break;
      case '--max-tokens':   opts.maxTokens = parseInt(next(), 10); break;
      case '--temperature':  opts.temperature = parseFloat(next()); break;
      case '--save':         opts.save = true; break;
      case '--no-save':      opts.save = false; break;
      case '-D':
      case '--input': {
        const kv = next();
        const eq = kv.indexOf('=');
        if (eq === -1) throw new Error(`--input expects key=value, got: ${kv}`);
        opts.inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
        break;
      }
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
modes/runner.mjs — headless executor for modes/*.md

USAGE
  node modes/runner.mjs --mode <name> [options]

OPTIONS
  --mode <name>           Required. modes/<name>.md to execute.
  --jd <path>             File whose contents bind to {{jd}}.
  --cv <path>             File whose contents bind to {{cv}} (default: cv.md if present).
  --out <path>            Write the rendered report to this path.
                          If omitted but --save is given, auto-numbers under reports/.
  --save / --no-save      Force on/off writing a report file. Default: write iff --out given.
  --provider <name>       Override provider. One of: ${listProviders().join(', ')}.
  --model <name>          Override the model identifier.
  --max-tokens <n>        Override max output tokens (default: 4096).
  --temperature <f>       Override temperature (default: 0.3).
  -D, --input key=value   Bind an arbitrary {{key}} placeholder (repeatable).
  -h, --help              Show this help.

ENV
  STUB_LLM=1              Force the deterministic stub provider (used in tests).

EXAMPLES
  node modes/runner.mjs --mode oferta \\
    --jd examples/sample-jd.txt --cv examples/cv-example.md --save

  STUB_LLM=1 node modes/runner.mjs --mode oferta \\
    -D jd="Senior AI Engineer at Acme" --out /tmp/report.md
`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`❌  ${e.message}`);
    process.exit(2);
  }

  if (opts.help || !opts.mode) {
    printHelp();
    process.exit(opts.help ? 0 : 2);
  }

  const inputs = { ...opts.inputs };

  if (opts.jd) {
    if (!existsSync(opts.jd)) {
      console.error(`❌  --jd file not found: ${opts.jd}`);
      process.exit(1);
    }
    inputs.jd = readFileSync(opts.jd, 'utf-8');
  }

  // Auto-load cv.md unless --cv given or already provided via -D cv=...
  let cvPath = opts.cv;
  if (!cvPath && !inputs.cv && existsSync(PATHS.cv)) cvPath = PATHS.cv;
  if (cvPath) {
    if (!existsSync(cvPath)) {
      console.error(`❌  --cv file not found: ${cvPath}`);
      process.exit(1);
    }
    inputs.cv = readFileSync(cvPath, 'utf-8');
  }

  const save = opts.save === true || (opts.save === null && Boolean(opts.out));

  try {
    const res = await runMode({
      mode: opts.mode,
      inputs,
      provider: opts.provider,
      model: opts.model,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      save,
      outPath: opts.out,
    });

    // Pretty result
    console.log(res.text);
    if (res.summary) {
      console.log('\n' + '─'.repeat(66));
      console.log(`  Score: ${formatScore(res.summary.score)}  |  Archetype: ${res.summary.archetype}  |  Legitimacy: ${res.summary.legitimacy}`);
      console.log('─'.repeat(66));
    }
    if (res.reportPath) {
      const rel = res.reportPath.startsWith(ROOT)
        ? res.reportPath.slice(ROOT.length + 1)
        : res.reportPath;
      console.log(`\n✅  Report saved: ${rel}`);
    }
    if (res.usage) {
      const u = res.usage;
      console.log(`\n📊  Tokens — in:${u.input_tokens ?? '?'}  out:${u.output_tokens ?? '?'}  total:${u.total_tokens ?? '?'}`);
    }
  } catch (e) {
    console.error(`\n❌  runMode failed: ${e.message}`);
    if (e.code === 'NO_API_KEY') {
      console.error(`    Hint: set the appropriate API key env var, or pass --provider stub for offline use.`);
    }
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
