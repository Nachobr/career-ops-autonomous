/**
 * commands/colab.mjs — manage the Google Colab LLM backend
 *
 * The Colab notebook in colab/career_ops_llm_server.ipynb spins up an
 * OpenAI-compatible vLLM server tunneled through ngrok. local-eval.mjs already
 * reads LOCAL_LLM_BASE_URL / LOCAL_LLM_API_KEY / LOCAL_LLM_MODEL from .env, so
 * this subcommand only needs to:
 *   - show what is configured
 *   - ping the endpoint and list models
 *   - help the user set the three env vars (writes to .env)
 *
 * Usage:
 *   career-ops colab status
 *   career-ops colab test
 *   career-ops colab set --base https://x.ngrok-free.app --model Qwen/Qwen2.5-7B-Instruct [--key sk-...]
 *   career-ops colab clear
 */

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');

const isTTY = process.stdout.isTTY;
const bold   = (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s;
const dim    = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;
const green  = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red    = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const cyan   = (s) => isTTY ? `\x1b[36m${s}\x1b[0m` : s;

const KEYS = ['LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL', 'LOCAL_LLM_API_KEY'];

function maskKey(v) {
  if (!v) return '';
  if (v.length <= 6) return '***';
  return v.slice(0, 3) + '***' + v.slice(-2);
}

function currentConfig() {
  return {
    base: process.env.LOCAL_LLM_BASE_URL || '',
    model: process.env.LOCAL_LLM_MODEL || '',
    key: process.env.LOCAL_LLM_API_KEY || '',
  };
}

function printStatus() {
  const { base, model, key } = currentConfig();
  console.log(`${bold('career-ops colab')} — Google Colab LLM backend`);
  console.log('');
  console.log(`  ${dim('source:')}      .env + process env`);
  console.log(`  ${dim('base URL:')}    ${base ? cyan(base) : red('(unset)')}`);
  console.log(`  ${dim('model:')}       ${model ? cyan(model) : red('(unset)')}`);
  console.log(`  ${dim('api key:')}     ${key ? green(maskKey(key)) : dim('(unset — ok if Colab server is open)')}`);
  console.log('');
  if (!base) {
    console.log(yellow('Not configured. Start the Colab notebook then run:'));
    console.log(`  career-ops colab set --base https://xxxx.ngrok-free.app --model Qwen/Qwen2.5-7B-Instruct`);
    console.log('');
    console.log(dim('See colab/README.md for the full setup.'));
    return 1;
  }
  console.log(green('Configured.') + ' Run `career-ops colab test` to ping the endpoint.');
  return 0;
}

async function pingEndpoint(base, key) {
  const url = base.replace(/\/$/, '') + '/v1/models';
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

async function testEndpoint() {
  const { base, model, key } = currentConfig();
  if (!base) {
    console.log(red('No LOCAL_LLM_BASE_URL set. Run `career-ops colab status`.'));
    return 1;
  }
  console.log(dim(`→ GET ${base.replace(/\/$/, '')}/v1/models`));
  const r = await pingEndpoint(base, key);
  if (!r.ok) {
    console.log(red(`✘ endpoint unreachable: ${r.error || 'HTTP ' + r.status}`));
    if (r.text) console.log(dim(r.text.slice(0, 300)));
    if (r.status === 404 && /ngrok/i.test(base)) {
      console.log(yellow('  ⚠ ngrok is reachable, but /v1/models returned 404. This usually means the Colab tunnel URL is stale or points at the wrong port/path.'));
      console.log(dim('  Restart/expose the OpenAI-compatible server in Colab, then run:'));
      console.log(dim('  career-ops colab set --base=https://YOUR-CURRENT-NGROK.app --model=qwen2.5:14b-instruct-q4_K_M'));
      console.log(dim('  career-ops colab test'));
    }
    return 1;
  }
  console.log(green(`✔ endpoint reachable (HTTP ${r.status})`));
  const models = (r.json?.data || []).map(m => m.id);
  if (models.length) {
    console.log(`  ${dim('models served:')}`);
    for (const m of models) {
      const match = model && (m === model || m.includes(model.split('/').pop()));
      console.log(`    ${match ? green('●') : dim('○')} ${m}`);
    }
    if (model && !models.some(m => m === model || m.includes(model.split('/').pop()))) {
      console.log(yellow(`  ⚠ configured model '${model}' not in served list — request may 404.`));
    }
  } else {
    console.log(yellow('  ⚠ no models returned (some vLLM versions disable /v1/models).'));
  }
  return 0;
}

function parseSetArgs(argv) {
  const opts = {};
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const a = normalizeCliArg(argv[i]);
    if (a === '--base' && argv[i + 1]) opts.base = argv[++i].replace(/\/$/, '');
    else if (a === '--model' && argv[i + 1]) opts.model = argv[++i];
    else if (a === '--key' && argv[i + 1]) opts.key = argv[++i];
    else if (a.startsWith('--base=')) {
      const v = a.slice(7) || (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '');
      if (v) opts.base = v.replace(/\/$/, '');
    }
    else if (a.startsWith('--model=')) {
      const v = a.slice(8) || (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '');
      if (v) opts.model = v;
    }
    else if (a.startsWith('--key=')) {
      const v = a.slice(6) || (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '');
      if (v) opts.key = v;
    }
    else unknown.push(argv[i]);
  }
  opts.unknown = unknown;
  return opts;
}

function normalizeCliArg(arg) {
  // Users often paste commands from rich text where -- becomes an em/en dash.
  // Treat those as normal long-option prefixes instead of silently ignoring
  // important flags like —model.
  return String(arg || '').replace(/^[\u2012\u2013\u2014\u2015]+/, (m) => '-'.repeat(m.length * 2));
}

function upsertEnvFile(updates) {
  let lines = [];
  if (existsSync(ENV_PATH)) {
    lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
  }
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      seen.add(m[1]);
      const v = updates[m[1]];
      return v === null ? null : `${m[1]}=${v}`;
    }
    return line;
  }).filter(l => l !== null);
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) continue;
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  // Trim trailing blank lines, leave exactly one
  while (out.length && out[out.length - 1] === '') out.pop();
  writeFileSync(ENV_PATH, out.join('\n') + '\n', 'utf-8');
}

function doSet(argv) {
  const opts = parseSetArgs(argv);
  if (opts.unknown?.length) {
    console.log(yellow(`Ignoring unknown argument(s): ${opts.unknown.join(' ')}`));
  }
  if (!opts.base && !opts.model && !opts.key) {
    console.log(red('Provide at least one of --base, --model, --key.'));
    console.log('Example:');
    console.log('  career-ops colab set --base https://xxxx.ngrok-free.app --model Qwen/Qwen2.5-7B-Instruct');
    return 2;
  }
  const updates = {};
  if (opts.base)  updates.LOCAL_LLM_BASE_URL = opts.base;
  if (opts.model) updates.LOCAL_LLM_MODEL    = opts.model;
  if (opts.key)   updates.LOCAL_LLM_API_KEY  = opts.key;
  upsertEnvFile(updates);
  console.log(green('✔ updated .env'));
  for (const [k, v] of Object.entries(updates)) {
    console.log(`  ${dim(k + '=')}${k === 'LOCAL_LLM_API_KEY' ? maskKey(v) : v}`);
  }
  console.log('');
  console.log(dim('Run `career-ops colab test` to verify the endpoint.'));
  return 0;
}

function doClear() {
  if (!existsSync(ENV_PATH)) {
    console.log(dim('.env does not exist — nothing to clear.'));
    return 0;
  }
  upsertEnvFile({ LOCAL_LLM_BASE_URL: null, LOCAL_LLM_MODEL: null, LOCAL_LLM_API_KEY: null });
  console.log(green('✔ cleared LOCAL_LLM_* keys from .env'));
  return 0;
}

function printHelp() {
  console.log(`${bold('career-ops colab')} — Google Colab LLM backend (vLLM + ngrok)

${bold('Usage:')}
  career-ops colab status
  career-ops colab test
  career-ops colab set --base <ngrok-url> --model <hf-id> [--key <token>]
  career-ops colab clear

${bold('Examples:')}
  career-ops colab set --base https://xxxx.ngrok-free.app --model Qwen/Qwen2.5-7B-Instruct
  career-ops colab test
  career-ops colab status

${bold('How it works:')}
  1. Open colab/career_ops_llm_server.ipynb in Google Colab (GPU runtime).
  2. Run all cells — you get a public ngrok URL.
  3. \`career-ops colab set --base <url> --model <model>\` writes .env.
  4. \`career-ops colab test\` pings /v1/models to verify.
  5. \`career-ops run\` (and \`career-ops eval ...\`) will now use the Colab LLM.
`);
}

export default async function colab(argv) {
  const sub = (argv && argv[0]) || 'status';
  const rest = (argv || []).slice(1);

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return 0;
  }
  if (sub === 'status') return printStatus();
  if (sub === 'test')   return await testEndpoint();
  if (sub === 'set')    return doSet(rest);
  if (sub === 'clear')  return doClear();

  console.error(`career-ops colab: unknown subcommand '${sub}'`);
  printHelp();
  return 2;
}
