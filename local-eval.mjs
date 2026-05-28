#!/usr/bin/env node
/**
 * local-eval.mjs — Evaluate a job description against the user CV using a local/API LLM
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATHS = {
  shared: join(ROOT, 'modes', '_shared.md'),
  oferta: join(ROOT, 'modes', 'oferta.md'),
  cv: join(ROOT, 'cv.md'),
  reports: join(ROOT, 'reports'),
};

// 1. Parse Args
const args = process.argv.slice(2);
let jdText = '';
let jdFile = null;
let modelName = process.env.LOCAL_LLM_MODEL || 'qwen2.5-3b';
let baseUrl = process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:8000';
let apiKey = process.env.LOCAL_LLM_API_KEY || 'none';
let saveReport = true;
let sourceUrl = '';
// Needle Mode = aggressive truncation. Originally designed for Groq's tiny
// context. Auto-enabled when LOCAL_LLM_BASE_URL points at Groq; can be forced
// on/off with --needle / --no-needle or NEEDLE_MODE=1 / NEEDLE_MODE=0.
let needleMode = null; // null = auto-detect after parsing

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    jdFile = args[++i];
    if (!existsSync(jdFile)) {
      console.error(`❌  File not found: ${jdFile}`);
      process.exit(1);
    }
    jdText = readFileSync(jdFile, 'utf-8').trim();
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--base' && args[i + 1]) {
    baseUrl = args[++i].replace(/\/$/, '');
  } else if (args[i] === '--url' && args[i + 1]) {
    sourceUrl = args[++i];
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (args[i] === '--needle') {
    needleMode = true;
  } else if (args[i] === '--no-needle') {
    needleMode = false;
  } else if (!args[i].startsWith('--')) {
    jdText += (jdText ? '\n' : '') + args[i];
  }
}

if (!jdText) {
  console.error('❌  No Job Description provided.');
  process.exit(1);
}

// Resolve Needle Mode: explicit flag > env > auto-detect (Groq only).
if (needleMode === null) {
  if (process.env.NEEDLE_MODE === '1') needleMode = true;
  else if (process.env.NEEDLE_MODE === '0') needleMode = false;
  else needleMode = baseUrl.includes('groq.com');
}

// Apply JD truncation only in Needle Mode.
if (needleMode && jdText.length > 500) {
  console.log('⚠️  JD truncated to 500 characters (Needle Mode)...');
  jdText = jdText.slice(0, 500) + '...';
}

// 2. Helpers
function readFile(path, label) {
  if (!existsSync(path)) return `[${label} not found]`;
  let content = readFileSync(path, 'utf-8').trim();
  if (needleMode && label === 'cv.md' && content.length > 1000) {
    console.log('⚠️  CV truncated to 1000 characters (Needle Mode)...');
    content = content.slice(0, 1000) + '...';
  }
  return content;
}

function nextReportNumber() {
  if (!existsSync(PATHS.reports)) return '001';
  const nums = readdirSync(PATHS.reports)
    .filter(f => /^\d{3}-/.test(f))
    .map(f => parseInt(f.slice(0, 3)))
    .filter(n => !isNaN(n));
  return String(Math.max(0, ...nums) + 1).padStart(3, '0');
}

// 3. Load Context
console.log('\n📂  Loading context files...');
const sharedContext = readFile(PATHS.shared, 'modes/_shared.md');
const ofertaLogic   = readFile(PATHS.oferta, 'modes/oferta.md');
const cvContent     = readFile(PATHS.cv,     'cv.md');

// 4. Build Prompt
let systemPrompt;
const isTankMode = baseUrl.includes('groq.com');

if (isTankMode) {
  console.log('🛡️  TANK MODE: Using condensed high-performance prompt...');
  systemPrompt = `You are career-ops, an AI job assistant. Evaluate the JD against the CV.
ARCHETYPES: FDE (delivery/client), SA (architecture/integration), PM (product/metrics), LLMOps (evals/production), Agentic (multi-agent/orchestration), Transformation (change/adoption).

TASK:
1. Identify Archetype.
2. Map JD requirements to CV lines. Find gaps.
3. Score 1-5.
4. Strategy: Sell founder experience as seniority.
5. Legitimacy: Check age and detail quality.

OUTPUT FORMAT:
Provide A-G evaluation blocks.
At the end, include:
---SCORE_SUMMARY---
COMPANY: {name}
ROLE: {title}
SCORE: {1-5}
ARCHETYPE: {type}
LEGITIMACY: {High|Medium|Low}
---END_SUMMARY---

CANDIDATE CV (Condensed):
${cvContent}
`;
} else {
  systemPrompt = `You are career-ops, an AI job assistant.
METHODOLOGY:
${sharedContext}
${ofertaLogic}

CANDIDATE CV:
${cvContent}

OUTPUT RULES:
- Generate Blocks A through G in full.
- At the very end, ALWAYS append a machine-readable summary in this exact format
  (the pipeline relies on it to fill the tracker — no report can omit it):

---SCORE_SUMMARY---
COMPANY: <company name as written in the JD, or "Unknown">
ROLE: <role title as written in the JD>
SCORE: <global score 1-5, decimal allowed, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;
}

// 5. Call LLM
console.log(`🤖  Calling LLM (${modelName}) at ${baseUrl} ...`);
try {
  const endpoint = `${baseUrl}/v1/chat/completions`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      temperature: 0.4,
      // Needle Mode (Groq) → keep responses tight. Full mode → enough room
      // for all 7 blocks (A-G) plus the SCORE_SUMMARY trailer.
      max_tokens: needleMode ? 2048 : 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `JOB DESCRIPTION:\n\n${jdText}` },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} — ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const evaluationText = data?.choices?.[0]?.message?.content;

  if (!evaluationText) throw new Error('Empty response');

  console.log('\n' + '═'.repeat(66));
  console.log(evaluationText);

  if (saveReport) {
    const summaryMatch = evaluationText.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
    let company = 'unknown';
    if (summaryMatch) {
      const m = summaryMatch[1].match(/COMPANY:\s*(.+)/);
      if (m) company = m[1].trim().toLowerCase().replace(/\s+/g, '-');
    }
    const num = nextReportNumber();
    const date = new Date().toISOString().split('T')[0];
    const reportName = `${num}-${company}-${date}.md`;

    // Inject the source URL into the header, between **Score:** and
    // **Legitimacy:**, so reports are self-contained and traceable. The LLM
    // can't be trusted to insert this reliably, so we do it deterministically.
    let finalText = evaluationText;
    if (sourceUrl && !/^\*\*URL:\*\*/m.test(finalText)) {
      const urlLine = `**URL:** ${sourceUrl}`;
      if (/^\*\*Score:\*\*.*$/m.test(finalText)) {
        finalText = finalText.replace(/^(\*\*Score:\*\*.*)$/m, `$1\n${urlLine}`);
      } else if (/^\*\*Legitimacy:\*\*.*$/m.test(finalText)) {
        finalText = finalText.replace(/^(\*\*Legitimacy:\*\*.*)$/m, `${urlLine}\n$1`);
      } else {
        // No recognizable header — prepend so the URL is never lost.
        finalText = `${urlLine}\n\n${finalText}`;
      }
    }

    writeFileSync(join(PATHS.reports, reportName), finalText);
    console.log(`\n💾 Report saved: reports/${reportName}`);
  }
} catch (err) {
  console.error('❌ Failed:', err.message);
  process.exit(1);
}
