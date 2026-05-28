#!/usr/bin/env node

/**
 * commands/login.mjs — configure LLM provider credentials in .env
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');

const PROVIDERS = {
  gemini: {
    env: 'GEMINI_API_KEY',
    label: 'Google Gemini',
    validate: async (key) => {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
      if (!res.ok) throw new Error(`Gemini API ${res.status}`);
    },
  },
  anthropic: {
    env: 'ANTHROPIC_API_KEY',
    label: 'Anthropic Claude',
    validate: async (key) => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-3-5-haiku-latest', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    },
  },
  openai: {
    env: 'OPENAI_API_KEY',
    label: 'OpenAI / OpenAI-compatible',
    validate: async (key) => {
      const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
      const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error(`OpenAI API ${res.status}`);
    },
  },
};

function parseArgs(argv) {
  const opts = { provider: null, status: false, force: false, noValidate: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--no-validate') opts.noValidate = true;
    else if (a === '--provider' && argv[i + 1]) opts.provider = argv[++i];
    else if (a.startsWith('--provider=')) opts.provider = a.slice('--provider='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log(`career-ops login — configure LLM provider credentials

Usage:
  career-ops login --status
  career-ops login --provider gemini [--force] [--no-validate]
  career-ops login --provider anthropic [--force] [--no-validate]
  career-ops login --provider openai [--force] [--no-validate]

Keys are written to .env and are never printed back to the terminal.
`);
}

function loadEnvFile() {
  return existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
}

function envHas(name) {
  if (process.env[name]) return true;
  return new RegExp(`^${name}=.+`, 'm').test(loadEnvFile());
}

function setEnvValue(name, value, { force = false } = {}) {
  let text = loadEnvFile();
  const lineRe = new RegExp(`^${name}=.*$`, 'm');
  if (lineRe.test(text)) {
    if (!force) throw new Error(`${name} already exists in .env; use --force to overwrite`);
    text = text.replace(lineRe, `${name}=${value}`);
  } else {
    if (text && !text.endsWith('\n')) text += '\n';
    text += `${name}=${value}\n`;
  }
  writeFileSync(ENV_PATH, text, 'utf-8');
}

function printStatus() {
  console.log('career-ops login status');
  for (const [name, meta] of Object.entries(PROVIDERS)) {
    console.log(`${envHas(meta.env) ? '✅' : '❌'} ${name.padEnd(9)} ${meta.env}`);
  }
  console.log(`${process.env.LOCAL_LLM_BASE_URL ? '✅' : envHas('LOCAL_LLM_BASE_URL') ? '✅' : '❌'} local     LOCAL_LLM_BASE_URL`);
  return 0;
}

async function promptSecret(provider) {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Paste ${PROVIDERS[provider].label} API key: `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

export default async function login(argv = []) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`career-ops login: ${e.message}`); return 2; }
  if (opts.help || (!opts.status && !opts.provider)) { printHelp(); return opts.help ? 0 : 2; }
  if (opts.status) return printStatus();

  const meta = PROVIDERS[opts.provider];
  if (!meta) {
    console.error(`career-ops login: unknown provider "${opts.provider}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`);
    return 2;
  }
  if (envHas(meta.env) && !opts.force) {
    console.error(`career-ops login: ${meta.env} already configured. Use --force to overwrite.`);
    return 1;
  }

  const key = await promptSecret(opts.provider);
  if (!key) {
    console.error('career-ops login: empty key; nothing written.');
    return 1;
  }
  if (!opts.noValidate) {
    try {
      await meta.validate(key);
    } catch (e) {
      console.error(`career-ops login: validation failed (${e.message}). Use --no-validate to store anyway.`);
      return 1;
    }
  }
  try {
    setEnvValue(meta.env, key, { force: opts.force });
  } catch (e) {
    console.error(`career-ops login: ${e.message}`);
    return 1;
  }
  console.log(`✅ ${meta.env} saved to .env`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  login(process.argv.slice(2)).then(code => process.exit(code ?? 0));
}
