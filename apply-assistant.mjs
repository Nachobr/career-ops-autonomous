#!/usr/bin/env node
/**
 * apply-assistant.mjs — Draft application answers using Colab LLM
 * 
 * Usage: node apply-assistant.mjs --report 001 --questions "Why do you want to work here?; What is your expected salary?"
 * Or: node apply-assistant.mjs --company "TechCorp" --file ./questions.txt
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = dirname(fileURLToPath(import.meta.url));

import { config } from 'dotenv';
config({ path: join(ROOT, '.env') });

const PATHS = {
  shared:   join(ROOT, 'modes', '_shared.md'),
  apply:    join(ROOT, 'modes', 'apply.md'),
  cv:       join(ROOT, 'cv.md'),
  reports:  join(ROOT, 'reports'),
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const baseUrl = (process.env.LOCAL_LLM_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const apiKey = process.env.LOCAL_LLM_API_KEY || 'career-ops-colab';
const modelName = process.env.LOCAL_LLM_MODEL || 'Qwen/Qwen2.5-3B-Instruct';

// ---------------------------------------------------------------------------
// CLI Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.findIndex(a => a === `--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
};

let reportNum = getArg('report');
let companySearch = getArg('company');
let urlSearch = getArg('url');
const questionsInput = getArg('questions');
const questionsFile = getArg('file');
const browserMode = args.includes('--browser');

// Positional convenience: `career-ops apply <url>` or `career-ops apply <num>`
// or `career-ops apply <company>` — pick whichever matches first non-flag arg.
const firstPositional = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--report' && args[args.indexOf(a) - 1] !== '--company' && args[args.indexOf(a) - 1] !== '--url' && args[args.indexOf(a) - 1] !== '--questions' && args[args.indexOf(a) - 1] !== '--file');
if (firstPositional && !reportNum && !companySearch && !urlSearch) {
  if (/^https?:\/\//i.test(firstPositional)) urlSearch = firstPositional;
  else if (/^\d+$/.test(firstPositional)) reportNum = firstPositional;
  else companySearch = firstPositional;
}

if (browserMode) {
  const mod = await import('./application-browser-assistant.mjs');
  const code = await mod.main(args);
  process.exit(code ?? 0);
}

if (!reportNum && !companySearch && !urlSearch) {
  console.error('❌ Error: Provide <url> | --report <num> | --company <name> | --url <url>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load Context
// ---------------------------------------------------------------------------

let reportContent = '';
let reportFile = '';

if (reportNum) {
  const files = readdirSync(PATHS.reports).filter(f => f.startsWith(reportNum.padStart(3, '0')));
  if (files.length === 0) {
    console.error(`❌ Error: Report #${reportNum} not found in reports/`);
    process.exit(1);
  }
  reportFile = files[0];
  reportContent = readFileSync(join(PATHS.reports, reportFile), 'utf-8');
} else if (urlSearch) {
  // Find the report whose header contains **URL:** matching the given URL.
  // Use a loose match so `?gh_jid=...` query-string variants still match.
  const norm = (u) => u.trim().replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  const target = norm(urlSearch);
  const matches = readdirSync(PATHS.reports)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ file: f, body: readFileSync(join(PATHS.reports, f), 'utf-8') }))
    .filter(({ body }) => {
      const m = body.match(/^\*\*URL:\*\*\s*(\S+)/m);
      return m && (m[1] === urlSearch || norm(m[1]) === target);
    });
  if (matches.length === 0) {
    console.error(`❌ Error: No report found with URL "${urlSearch}"`);
    console.error('   Hint: the report must contain a "**URL:** <url>" header line.');
    process.exit(1);
  }
  reportFile = matches[0].file;
  reportContent = matches[0].body;
} else {
  const files = readdirSync(PATHS.reports).filter(f => f.toLowerCase().includes(companySearch.toLowerCase()));
  if (files.length === 0) {
    console.error(`❌ Error: No report found for company "${companySearch}"`);
    process.exit(1);
  }
  reportFile = files[0];
  reportContent = readFileSync(join(PATHS.reports, reportFile), 'utf-8');
}

const cvContent = existsSync(PATHS.cv) ? readFileSync(PATHS.cv, 'utf-8') : 'CV missing';
const sharedMode = readFileSync(PATHS.shared, 'utf-8');
const applyMode = readFileSync(PATHS.apply, 'utf-8');

let questions = '';
if (questionsInput) {
  questions = questionsInput.split(';').map(q => `- ${q.trim()}`).join('\n');
} else if (questionsFile && existsSync(questionsFile)) {
  questions = readFileSync(questionsFile, 'utf-8');
} else {
  console.error('❌ Error: Provide --questions "q1; q2" or --file <path>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Call LLM
// ---------------------------------------------------------------------------

const systemPrompt = `
${sharedMode}

${applyMode}

CONTEXT:
- Candidate CV:
${cvContent}

- Job Evaluation Report:
${reportContent}

GOAL:
Generate high-quality, personalized responses for the following application form questions.
Use the STAR stories and proof points from the evaluation report.
Maintain a "I'm choosing you" tone—specific, professional, and high-value.

QUESTIONS TO ANSWER:
${questions}
`;

console.log(`🤖  Generating answers for ${reportFile} using ${modelName}...`);

try {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'ngrok-skip-browser-warning': 'true',
    },
    body: JSON.stringify({
      model: modelName,
      temperature: 0.3,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Please generate the responses for the questions provided.' },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} — ${body.slice(0, 400)}`);
  }

  const data = await res.json();
  const answers = data?.choices?.[0]?.message?.content;

  if (!answers) {
    throw new Error('No content received from LLM');
  }

  console.log('\n' + '═'.repeat(66));
  console.log('  📝  DRAFT APPLICATION RESPONSES');
  console.log('═'.repeat(66) + '\n');
  console.log(answers);
  console.log('\n' + '═'.repeat(66));
  console.log('  ⚠️  REVIEW BEFORE COPY-PASTING');
  console.log('═'.repeat(66));

} catch (err) {
  console.error(`❌  Application Assistant failed: ${err.message}`);
  process.exit(1);
}
