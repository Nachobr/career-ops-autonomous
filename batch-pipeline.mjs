#!/usr/bin/env node
/**
 * batch-pipeline.mjs — Automatically evaluate all pending jobs in the inbox
 * 
 * Flow:
 * 1. Read data/pipeline.md (Pendientes section)
 * 2. For each URL:
 *    - Scrape JD content using Playwright
 *    - Evaluate with modes/runner.mjs by default (or claude -p with --engine=claude)
 *    - Update pipeline.md status
 * 3. Finalize
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { chromium } from 'playwright';
import { runMode } from './modes/runner.mjs';
import { DEFAULT_RETRY, withRetry } from './lib/retry.mjs';
import { recordDeadLetter } from './lib/dead-letter.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const REPORTS_DIR = join(ROOT, 'reports');
const TRACKER_ADDITIONS_DIR = join(ROOT, 'batch', 'tracker-additions');
const CV_PATH = join(ROOT, 'cv.md');
const OUTPUT_DIR = join(ROOT, 'output');
const BATCH_PROMPT_PATH = join(ROOT, 'batch', 'batch-prompt.md');
const APPS_FILE = existsSync(join(ROOT, 'data', 'applications.md'))
  ? join(ROOT, 'data', 'applications.md')
  : join(ROOT, 'applications.md');

// ── Tracker-additions helpers ──────────────────────────────────────────────
// After each successful eval we emit one TSV row into
// batch/tracker-additions/run-<ISO>.tsv so that `career-ops merge` picks it
// up and appends/updates data/applications.md. Schema is the 9-col format
// merge-tracker.mjs accepts: num \t date \t company \t role \t status \t
// score \t pdf \t report \t notes

function snapshotReportSet() {
  if (!existsSync(REPORTS_DIR)) return new Set();
  return new Set(readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')));
}

function findNewReports(prevSet) {
  if (!existsSync(REPORTS_DIR)) return [];
  return readdirSync(REPORTS_DIR)
    .filter(f => f.endsWith('.md') && !prevSet.has(f))
    .sort();
}

function reportNumberFromName(name) {
  const m = /^(\d{3})-/.exec(name);
  return m ? m[1] : null;
}

function parseScoreSummary(text) {
  // Try the canonical fence first.
  let block = null;
  const canonical = text.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
  if (canonical) block = canonical[1];

  // Fallback: model used a non-canonical header (e.g. "MACHINE-READABLE
  // SUMMARY" followed by --- key-value lines --- END_SUMMARY ---). Look for
  // any block that contains COMPANY:, ROLE: and SCORE: together near the end.
  if (!block) {
    const candidates = [...text.matchAll(/(?:^|\n)((?:\s*(?:[-*]\s*)?\*{0,2}[A-Z][A-Z_ ]+\*{0,2}:\s*.+\n?){3,})/gi)];
    for (const c of candidates.reverse()) {
      if (/company\*{0,2}:/i.test(c[1]) && /role\*{0,2}:/i.test(c[1]) && /score\*{0,2}:/i.test(c[1])) {
        block = c[1];
        break;
      }
    }
  }
  // Fallback 2: runner-engine reports (modes/runner.mjs) strip the fenced
  // summary and write the values into the markdown header instead, e.g.
  //   # Evaluation: PhysicsX — Forward Deployed Software Engineer
  //   **Score:** 4.3/5
  //   **Archetype:** ...
  //   **Legitimacy:** ...
  if (!block) {
    const headerGet = (key) => {
      const mm = text.match(new RegExp(`(?:^|\\n)\\s*\\*{2}${key}:\\*{2}\\s*(.+)`, 'i'));
      return mm ? mm[1].trim() : null;
    };
    const score = headerGet('Score');
    if (score) {
      const evalTitle = text.match(/^#\s*Evaluation:\s*(.+?)\s+[—–-]\s+(.+)$/m);
      return {
        company:    evalTitle ? evalTitle[1].trim() : null,
        role:       evalTitle ? evalTitle[2].trim() : null,
        score,
        archetype:  headerGet('Archetype'),
        legitimacy: headerGet('Legitimacy'),
      };
    }
  }

  if (!block) return null;

  const get = (key) => {
    const mm = block.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?\\*{0,2}${key}\\*{0,2}:\\s*(.+)`, 'i'));
    return mm ? mm[1].replace(/\s{2,}$/, '').trim() : null;
  };
  return {
    company:    get('COMPANY'),
    role:       get('ROLE'),
    score:      get('SCORE'),
    archetype:  get('ARCHETYPE'),
    legitimacy: get('LEGITIMACY'),
  };
}

function nextTrackerId() {
  // Look at existing applications.md rows and the report numbers in reports/
  // and return the larger of the two + 1, zero-padded to 3 digits to match
  // the report-file convention.
  let maxId = 0;
  if (existsSync(APPS_FILE)) {
    for (const line of readFileSync(APPS_FILE, 'utf-8').split('\n')) {
      const m = /^\s*\|\s*(\d+)\s*\|/.exec(line);
      if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
    }
  }
  if (existsSync(REPORTS_DIR)) {
    for (const f of readdirSync(REPORTS_DIR)) {
      const m = /^(\d{3})-/.exec(f);
      if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
    }
  }
  return String(maxId + 1).padStart(3, '0');
}

function cleanCompany(name, fallback) {
  if (!name) return fallback || 'Unknown';
  const trimmed = name.trim();
  // The model sometimes echoes the placeholder text literally; normalize.
  if (/^(unknown|company name not provided|n\/?a|none|not provided)$/i.test(trimmed)) {
    return fallback || 'Unknown';
  }
  return trimmed;
}

function cleanRole(name, fallback) {
  if (!name) return fallback || 'Unknown';
  const trimmed = name.trim();
  if (/^(unknown|role title|n\/?a|none|not provided)$/i.test(trimmed)) {
    return fallback || 'Unknown';
  }
  return trimmed;
}

function normalizeScore(raw) {
  if (!raw) return 'N/A';
  // Accept "3.8", "3.8/5", "**3.8**" etc.
  const m = String(raw).replace(/\*/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return 'N/A';
  return `${m[1]}/5`;
}

function parsePdfPath(reportText) {
  const m = reportText.match(/^\*\*PDF:\*\*\s*(.+)$/m);
  const value = m?.[1]?.trim() || '';
  return value && !/^(pending|none|n\/a|-)/i.test(value) ? value : '';
}

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function markdownToSimpleHtml(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    if (line.startsWith('# ')) { closeList(); out.push(`<h1>${escapeHtml(line.slice(2))}</h1>`); }
    else if (line.startsWith('## ')) { closeList(); out.push(`<h2>${escapeHtml(line.slice(3))}</h2>`); }
    else if (line.startsWith('### ')) { closeList(); out.push(`<h3>${escapeHtml(line.slice(4))}</h3>`); }
    else if (/^-\s+/.test(line)) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${escapeHtml(line.replace(/^-\s+/, ''))}</li>`); }
    else { closeList(); out.push(`<p>${escapeHtml(line)}</p>`); }
  }
  closeList();
  return out.join('\n');
}

function detectLanguage(text) {
  if (!text) return 'en';
  const spanishWords = /\b(experiencia|requisitos|empresa|trabajo|desarrollo|conocimientos?|años|responsabilidades|ofrecemos|perfil|tecnologías|habilidades|equipo|contrato|remoto|salario|beneficios|buscamos|postular|postularse|CV|español|con|para|una|este|como)\b/gi;
  const matches = text.match(spanishWords);
  const count = matches ? matches.length : 0;
  return count > 3 ? 'es' : 'en';
}

function getCandidateFullName() {
  try {
    const profilePath = join(ROOT, 'config', 'profile.yml');
    if (existsSync(profilePath)) {
      const parsed = yaml.load(readFileSync(profilePath, 'utf-8'));
      if (parsed?.candidate?.full_name) {
        return parsed.candidate.full_name;
      }
    }
  } catch (e) {
    console.warn(`⚠️  Could not read candidate full name from profile.yml: ${e.message}`);
  }
  return 'candidate';
}

function generatedPdfName() {
  const fullName = getCandidateFullName();
  const slug = fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `cv-${slug}.pdf`;
}

function generatePdfForReport(reportFile, { job, summary } = {}) {
  let jdText = job?.jd || '';
  if (!jdText && reportFile) {
    try {
      jdText = readFileSync(join(REPORTS_DIR, reportFile), 'utf-8');
    } catch {}
  }
  const lang = detectLanguage(jdText);
  const cvFile = lang === 'es'
    ? (existsSync(join(ROOT, 'cv.md')) ? 'cv.md' : 'cv-en.md')
    : (existsSync(join(ROOT, 'cv-en.md')) ? 'cv-en.md' : 'cv.md');
  const cvPath = join(ROOT, cvFile);

  if (!existsSync(cvPath)) return null;

  const company = cleanCompany(summary?.company, job?.company || 'company');
  const role = cleanRole(summary?.role, job?.title || 'role');
  const cv = readFileSync(cvPath, 'utf-8');

  const num = reportNumberFromName(reportFile) || 'draft';
  const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const jobDirRel = `output/${num}-${companySlug}`;
  const jobDir = join(ROOT, jobDirRel);
  mkdirSync(jobDir, { recursive: true });

  const htmlPath = join(jobDir, `.cv-${num}-${Date.now()}.html`);
  const pdfName = generatedPdfName();
  const pdfRel = `${jobDirRel}/${pdfName}`;
  const pdfPath = join(ROOT, pdfRel);

  const label = lang === 'es'
    ? `Adaptado para ${escapeHtml(company)} — ${escapeHtml(role)}`
    : `Tailored for ${escapeHtml(company)} — ${escapeHtml(role)}`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(company)} CV</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:42px;color:#111827;line-height:1.45;font-size:12px}h1{font-size:26px;margin:0 0 12px}h2{font-size:15px;margin:18px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}h3{font-size:13px;margin:12px 0 4px}p{margin:4px 0}ul{margin:5px 0 8px 18px;padding:0}li{margin:3px 0}.target{font-size:11px;color:#4b5563;margin-bottom:14px}
</style></head><body><div class="target">${label}</div>${markdownToSimpleHtml(cv)}</body></html>`;
  writeFileSync(htmlPath, html, 'utf-8');
  try {
    execFileSync(process.execPath, [join(ROOT, 'generate-pdf.mjs'), htmlPath, pdfPath], { cwd: ROOT, stdio: 'inherit' });
    const reportPath = join(REPORTS_DIR, reportFile);
    const reportText = readFileSync(reportPath, 'utf-8');
    const nextText = /^\*\*PDF:\*\*/m.test(reportText)
      ? reportText.replace(/^\*\*PDF:\*\*.*$/m, `**PDF:** ${pdfRel}`)
      : reportText.replace(/^(\*\*Legitimacy:\*\*.*)$/m, `$1\n**PDF:** ${pdfRel}`);
    writeFileSync(reportPath, nextText, 'utf-8');
    return pdfRel;
  } finally {
    try { unlinkSync(htmlPath); } catch {}
  }
}

function emitTrackerRow({ job, reportFile }) {
  // merge-tracker.mjs treats each TSV file as a single entry
  // (content.split('\t') of the whole file), so we MUST write one row per
  // file, no header. This matches the existing local-XXX.tsv convention.
  const reportPath = join(REPORTS_DIR, reportFile);
  let summary = null;
  try {
    summary = parseScoreSummary(readFileSync(reportPath, 'utf-8'));
  } catch {
    // ignore — we'll fall back to job fields
  }

  const num = reportNumberFromName(reportFile) || nextTrackerId();
  const date = new Date().toISOString().slice(0, 10);
  const company = cleanCompany(summary?.company, job.company);
  const role = cleanRole(summary?.role, job.title);
  const status = 'Evaluated';
  const score = normalizeScore(summary?.score);
  let pdf = '❌';
  try {
    const pdfPath = parsePdfPath(readFileSync(reportPath, 'utf-8'));
    if (pdfPath && existsSync(join(ROOT, pdfPath))) pdf = '✅';
  } catch {}
  const report = `[${num}](reports/${reportFile})`;
  const notes = '';

  const row = [num, date, company, role, status, score, pdf, report, notes].join('\t');
  mkdirSync(TRACKER_ADDITIONS_DIR, { recursive: true });
  const fileName = `run-${num}-${date}.tsv`;
  const filePath = join(TRACKER_ADDITIONS_DIR, fileName);
  writeFileSync(filePath, row + '\n', 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// 1. Extract Pending URLs
// ---------------------------------------------------------------------------
function getPendingJobs() {
  if (!existsSync(PIPELINE_PATH)) return [];
  const content = readFileSync(PIPELINE_PATH, 'utf-8');
  const lines = content.split('\n');
  
  const pending = [];
  let inPendientes = false;
  
  for (const line of lines) {
    if (line.includes('## Pendientes')) {
      inPendientes = true;
      continue;
    }
    if (line.startsWith('## ')) {
      inPendientes = false;
      continue;
    }
    
    if (inPendientes && line.trim().startsWith('- [ ]')) {
      // Format: - [ ] URL | Company | Title
      const match = line.match(/- \[ \] (https?:\/\/\S+)(?: \| ([^|]+) \| (.*))?/);
      if (match) {
        pending.push({
          url: match[1],
          company: match[2]?.trim() || 'Unknown',
          title: match[3]?.trim() || 'Unknown Role',
          rawLine: line
        });
      }
    }
  }
  return pending;
}

// ---------------------------------------------------------------------------
// 2. Scrape JD Content
// ---------------------------------------------------------------------------
const SCRAPE_TIMEOUT_MS = parseInt(process.env.CAREER_OPS_SCRAPE_TIMEOUT_MS || '15000', 10);
const API_TIMEOUT_MS = parseInt(process.env.CAREER_OPS_API_TIMEOUT_MS || '8000', 10);

function firstLine(err) {
  return String(err?.message || err || 'error').split('\n')[0];
}

function retryLog(err, attempt, delayMs) {
  console.warn(`  ↻ retry ${attempt} after ${delayMs}ms: ${firstLine(err)}`);
}

function isRetryableHttp(err) {
  if (!err) return false;
  if (err.status) return err.status === 429 || err.status >= 500;
  const msg = String(err.message || err);
  return /fetch failed|network|timeout|abort|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|429|5\d\d/i.test(msg);
}

function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function fetchJsonWithTimeout(url) {
  try {
    const res = await withRetry(async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS), headers: { 'User-Agent': 'career-ops/1.0' } });
      if (!response.ok && (response.status === 429 || response.status >= 500)) {
        const err = new Error(`HTTP ${response.status}`);
        err.status = response.status;
        throw err;
      }
      return response;
    }, {
      ...DEFAULT_RETRY,
      retryOn: isRetryableHttp,
      onRetry: retryLog,
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, json: await res.json() };
  } catch (e) {
    if (e.status) return { ok: false, status: e.status };
    return { ok: false, error: e.message };
  }
}

function slugCandidatesFromCompany(name) {
  if (!name) return [];
  const base = name.toLowerCase().trim();
  return Array.from(new Set([
    base.replace(/\s+/g, ''),       // "HelloFresh" → "hellofresh"
    base.replace(/\s+/g, '-'),      // "HelloFresh" → "hello-fresh"
    base.replace(/[^a-z0-9]/g, ''), // strip everything else
  ])).filter(Boolean);
}

async function tryGreenhouseApi(url, companyHint) {
  // 1. URL has explicit gh_jid → use it
  const ghJid = url.match(/[?&]gh_jid=(\d+)/);
  // 2. Boards subdomain → slug embedded in path
  const boardsSlug = url.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  let jobId = ghJid ? ghJid[1] : (url.match(/\/jobs\/(\d{5,})/) || [])[1];
  if (!jobId) return null;

  const slugs = boardsSlug
    ? [boardsSlug[1]]
    : slugCandidatesFromCompany(companyHint);

  for (const slug of slugs) {
    const api = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?content=true`;
    const r = await fetchJsonWithTimeout(api);
    if (r.ok && r.json?.content) {
      const text = htmlToText(r.json.content);
      if (text.length >= 200) {
        return `${r.json.title || ''}\n\n${text}`.trim();
      }
    }
    if (r.ok === false && r.status === 404) continue; // try next slug
  }
  return null;
}

async function tryAshbyApi(url) {
  const m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (!m) return null;
  const [, org, uuid] = m;
  const api = `https://api.ashbyhq.com/posting-api/job-board/${org}?includeCompensation=false`;
  const r = await fetchJsonWithTimeout(api);
  if (!r.ok || !Array.isArray(r.json?.jobs)) return null;
  const job = r.json.jobs.find(j => j.id === uuid);
  if (!job) return null;
  const text = htmlToText(job.descriptionHtml || job.description || '');
  if (text.length < 200) return null;
  return `${job.title || ''}\n\n${text}`.trim();
}

async function scrapeViaApi(url, companyHint) {
  try {
    const gh = await tryGreenhouseApi(url, companyHint);
    if (gh) return { text: gh, source: 'greenhouse-api' };
  } catch {}
  try {
    const ab = await tryAshbyApi(url);
    if (ab) return { text: ab, source: 'ashby-api' };
  } catch {}
  return null;
}

async function scrapeJD(browser, url, companyHint) {
  // Fast path: official job-board JSON APIs (bypasses Cloudflare, no Chromium).
  const apiResult = await scrapeViaApi(url, companyHint);
  if (apiResult) {
    console.log(`  ↳ via ${apiResult.source} (${apiResult.text.length} chars)`);
    return apiResult.text;
  }
  // Fallback: real browser for non-API portals (custom careers pages, Workday, etc.).
  let page;
  try {
    page = await browser.newPage();
  } catch (err) {
    console.error(`❌  Could not open page for ${url}: ${err.message}`);
    return null;
  }
  try {
    console.log(`🌐  Scraping: ${url}...`);
    const jd = await withRetry(async () => {
      // domcontentloaded fires fast; 'networkidle' never resolves on sites with
      // long-polling / analytics beacons (HelloFresh, Workday, etc.).
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SCRAPE_TIMEOUT_MS });

      // Small settle wait so SPA boards (Ashby, Greenhouse embed) render content.
      await page.waitForTimeout(1500);

      return await page.evaluate(() => {
        // Better selectors for common job boards
        const selectors = [
          '[class*="ashby-job-posting-content"]', // Ashby (partial match)
          '#job-description', 
          '.job-description',
          '.postings-container',
          '#section-main',
          'main', 'article'
        ];
        
        for (const s of selectors) {
          const el = document.querySelector(s);
          if (el && el.innerText.length > 200) {
            return el.innerText.replace(/\s+/g, ' ').trim();
          }
        }
        // Fallback: try to find the largest text block
        const divs = Array.from(document.querySelectorAll('div, section'));
        const largest = divs.sort((a, b) => b.innerText.length - a.innerText.length)[0];
        return largest ? largest.innerText.replace(/\s+/g, ' ').trim() : document.body.innerText;
      });
    }, {
      ...DEFAULT_RETRY,
      attempts: 3,
      retryOn: isRetryableHttp,
      onRetry: retryLog,
    });
    
    return jd.trim();
  } catch (err) {
    console.error(`❌  Failed to scrape ${url}: ${firstLine(err)}`);
    try {
      recordDeadLetter({ source: 'scrape', url, error: err, attempts: err.attempts ?? 1 });
    } catch (dlqErr) {
      console.warn(`⚠️  Could not record dead-letter entry: ${firstLine(dlqErr)}`);
    }
    return null;
  } finally {
    try { if (page) await page.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 3. Update Pipeline Status
// ---------------------------------------------------------------------------
function markAsProcessed(job) {
  let content = readFileSync(PIPELINE_PATH, 'utf-8');
  
  // Replace the pending line with a checked one
  const processedLine = job.rawLine.replace('- [ ]', '- [x]');
  content = content.replace(job.rawLine, processedLine);
  
  // Optional: Move from Pendientes to Procesadas section
  // For simplicity, we just check the box in this version
  
  writeFileSync(PIPELINE_PATH, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function detectLocalBackend() {
  // Heuristic: anything other than a known cloud rate-limited backend means
  // we can run with a short inter-job delay.
  const base = (process.env.LOCAL_LLM_BASE_URL || '').toLowerCase();
  if (!base) return false;
  if (base.includes('groq.com')) return false;       // strict RPM limits
  if (base.includes('openai.com')) return false;
  if (base.includes('anthropic.com')) return false;
  if (base.includes('googleapis.com')) return false;
  return true; // ollama / vllm / colab / localhost → local backend
}

function backendLabel() {
  const base = (process.env.LOCAL_LLM_BASE_URL || '').toLowerCase();
  if (base.includes('ngrok')) return 'colab/ngrok';
  if (base.includes('localhost') || base.includes('127.0.0.1')) return 'local/openai-compatible';
  return detectLocalBackend() ? 'custom/openai-compatible' : 'cloud';
}

function printHelp() {
  console.log(`batch-pipeline.mjs — evaluate pending jobs from data/pipeline.md

Usage:
  node batch-pipeline.mjs [flags]

Flags:
  --max-jobs N             Cap the number of pending jobs evaluated.
  --engine=runner|claude   Evaluation engine (default: $CAREER_OPS_ENGINE or runner).
  -h, --help               Show this help.

Environment:
  CAREER_OPS_MAX_JOBS      Same as --max-jobs when the flag is omitted.
  CAREER_OPS_ENGINE        Same as --engine when the flag is omitted.
  STUB_LLM=1               Force the offline deterministic runner provider.
`);
}

function parseCliOptions() {
  const args = process.argv.slice(2);
  const opts = {
    help: false,
    maxJobs: null,
    engine: process.env.CAREER_OPS_ENGINE || 'runner',
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--max-jobs=')) opts.maxJobs = parseInt(a.slice('--max-jobs='.length), 10);
    else if (a === '--max-jobs' && args[i + 1]) opts.maxJobs = parseInt(args[++i], 10);
    else if (a.startsWith('--engine=')) opts.engine = a.slice('--engine='.length);
    else if (a === '--engine' && args[i + 1]) opts.engine = args[++i];
    else if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
  }

  if (opts.maxJobs !== null && !Number.isInteger(opts.maxJobs)) {
    throw new Error('--max-jobs must be an integer');
  }
  if (!['runner', 'claude'].includes(opts.engine)) {
    throw new Error('--engine must be one of: runner, claude');
  }
  return opts;
}

function reportPathToFile(reportPath) {
  return basename(reportPath);
}

async function evaluateWithRunner(job, jd) {
  const cv = existsSync(CV_PATH) ? readFileSync(CV_PATH, 'utf-8') : '';
  const openAiCompatibleBase = process.env.LOCAL_LLM_BASE_URL;
  if (openAiCompatibleBase) {
    const base = openAiCompatibleBase.replace(/\/$/, '');
    process.env.OPENAI_BASE_URL = base.endsWith('/v1') ? base : `${base}/v1`;
    process.env.OPENAI_API_KEY = process.env.LOCAL_LLM_API_KEY || process.env.OPENAI_API_KEY || 'none';
  }
  const res = await runMode({
    mode: 'oferta',
    inputs: {
      jd,
      cv,
      company: job.company,
      role: job.title,
      url: job.url,
      sourceUrl: job.url,
    },
    provider: openAiCompatibleBase ? 'openai' : null,
    model: process.env.LOCAL_LLM_MODEL || null,
    save: true,
  });
  if (!res.reportPath) throw new Error('runner completed without writing a report');
  const reportFile = reportPathToFile(res.reportPath);
  console.log(`💾  Report saved: reports/${reportFile}`);
  return [reportFile];
}

function isLikelyBackendFailure(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return /fetch failed|econn|enotfound|etimedout|timeout|socket|network|ngrok|502|503|504|openai api|no_api_key/.test(msg);
}

function evaluateWithClaude(job, jdFile) {
  if (!existsSync(BATCH_PROMPT_PATH)) {
    throw new Error(`batch prompt not found: ${BATCH_PROMPT_PATH}`);
  }
  const reportNum = nextTrackerId();
  const date = new Date().toISOString().slice(0, 10);
  const promptFile = join(ROOT, 'batch', `.resolved-prompt-pipeline-${process.pid}-${reportNum}.md`);
  const prompt = readFileSync(BATCH_PROMPT_PATH, 'utf-8')
    .replaceAll('{{URL}}', job.url || '')
    .replaceAll('{{JD_FILE}}', jdFile)
    .replaceAll('{{REPORT_NUM}}', reportNum)
    .replaceAll('{{DATE}}', date)
    .replaceAll('{{ID}}', reportNum);
  writeFileSync(promptFile, prompt, 'utf-8');
  try {
    execFileSync('claude', [
      '-p',
      '--dangerously-skip-permissions',
      '--append-system-prompt-file', promptFile,
      `Evaluate ${job.company} — ${job.title}. Use JD file ${jdFile}.`,
    ], { cwd: ROOT, stdio: 'inherit' });
  } finally {
    try { unlinkSync(promptFile); } catch {}
  }
  return [];
}

async function main() {
  let opts;
  try {
    opts = parseCliOptions();
  } catch (e) {
    console.error(`❌  ${e.message}`);
    process.exit(2);
  }
  if (opts.help) {
    printHelp();
    return;
  }

  const all = getPendingJobs();

  if (all.length === 0) {
    console.log('✅ No pending jobs to evaluate.');
    return;
  }

  // Cap: CLI flag > env (set by `career-ops run --max-jobs N`) > unlimited
  const cliMax = opts.maxJobs;
  const envMax = parseInt(process.env.CAREER_OPS_MAX_JOBS || '', 10);
  const maxJobs = Number.isInteger(cliMax) ? cliMax
                : Number.isInteger(envMax) ? envMax
                : null;
  const pending = maxJobs != null ? all.slice(0, maxJobs) : all;

  const isLocal = detectLocalBackend();
  const delayMs = parseInt(process.env.CAREER_OPS_JOB_DELAY_MS || (isLocal ? '1000' : '20000'), 10);

  console.log(`🚀 Starting batch evaluation: ${pending.length} of ${all.length} pending`
            + (maxJobs != null ? ` (capped at ${maxJobs})` : '')
            + ` · delay=${delayMs}ms · engine=${opts.engine}`
            + ` · backend=${backendLabel()}`);

  const browser = await chromium.launch({ headless: true });

  // Cleanly close the browser on Ctrl+C so we don't leave Chromium zombies.
  let interrupted = false;
  const onSig = () => { interrupted = true; console.log('\n🛑 Interrupt received — finishing current job then stopping.'); };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let stoppedForBackend = false;

  try {
    for (const job of pending) {
      if (interrupted) break;

      const jd = await scrapeJD(browser, job.url, job.company);
      job.jd = jd;

      if (!jd || jd.length < 200) {
        console.warn(`⏭️  Skipping ${job.company}: Could not extract enough text.`);
        // Mark as processed anyway so the same broken URL doesn't reappear
        // every run. The user can re-add it manually if the site comes back.
        markAsProcessed(job);
        skipped++;
        continue;
      }

      const tempFile = join(ROOT, 'data', 'temp-jd.txt');
      writeFileSync(tempFile, jd, 'utf-8');

      try {
        console.log(`🤖  Evaluating ${job.company} — ${job.title}...`);
        const before = snapshotReportSet();
        const directReports = opts.engine === 'runner'
          ? await evaluateWithRunner(job, jd)
          : evaluateWithClaude(job, tempFile);
        markAsProcessed(job);
        processed++;

        // Identify the report(s) that local-eval.mjs just wrote and emit a
        // TSV row per new report so `career-ops merge` can pick them up.
        // High-scoring evals also get enqueued into the submit-review queue.
        const newReports = Array.from(new Set([...directReports, ...findNewReports(before)]));
        for (const reportFile of newReports) {
          let summary = null;
          try {
            summary = parseScoreSummary(readFileSync(join(REPORTS_DIR, reportFile), 'utf-8'));
            const pdf = generatePdfForReport(reportFile, { job, summary });
            if (pdf) console.log(`📄  PDF generated: ${pdf}`);
          } catch (e) {
            console.warn(`⚠️  Could not generate PDF for ${reportFile}: ${e.message}`);
          }
          try {
            emitTrackerRow({ job, reportFile });
          } catch (e) {
            console.warn(`⚠️  Could not emit tracker row for ${reportFile}: ${e.message}`);
          }
          try {
            summary ||= parseScoreSummary(readFileSync(join(REPORTS_DIR, reportFile), 'utf-8'));
            if (summary) {
              const { enqueueIfQualified } = await import('./commands/review.mjs');
              const num = reportNumberFromName(reportFile);
              const entry = await enqueueIfQualified({
                company: cleanCompany(summary.company, job.company),
                role:    cleanRole(summary.role, job.title),
                url:     job.url || '-',
                report:  num ? `[${num}](reports/${reportFile})` : `reports/${reportFile}`,
                score:   summary.score,
              });
              if (entry) console.log(`🛎️  Queued for review → ${entry.id} (career-ops review approve ${entry.id})`);
            }
          } catch (e) {
            console.warn(`⚠️  Could not enqueue ${reportFile} for review: ${e.message}`);
          }
        }
        if (newReports.length === 0) {
          console.warn(`⚠️  No new report file detected for ${job.company} — tracker row not emitted.`);
        } else {
          console.log(`📝  Tracker addition queued (${newReports.length}) → ${TRACKER_ADDITIONS_DIR.replace(ROOT + '/', '')}`);
        }

        console.log(`✅  Done with ${job.company}`);
      } catch (err) {
        failed++;
        console.error(`❌  Evaluation failed for ${job.company}: ${firstLine(err)}`);
        try {
          recordDeadLetter({ source: 'llm', url: job.url, error: err, attempts: err.attempts ?? 1 });
        } catch (dlqErr) {
          console.warn(`⚠️  Could not record dead-letter entry: ${firstLine(dlqErr)}`);
        }
        if (isLikelyBackendFailure(err)) {
          stoppedForBackend = true;
          console.error('🛑 LLM backend appears unavailable. Stopping batch so pending jobs remain queued for a later resume.');
          break;
        }
      } finally {
        if (!interrupted && delayMs > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
        console.log('');
      }
    }
  } finally {
    try { await browser.close(); } catch {}
  }

  console.log(`🏁 Batch processing complete: ${processed} evaluated, ${skipped} skipped, ${failed} failed`
            + (interrupted ? ' (interrupted)' : '')
            + (stoppedForBackend ? ' (backend unavailable)' : ''));
  console.log('📊 Run "career-ops merge" to finalize your application list.');

  if (interrupted) process.exit(130);
  if (stoppedForBackend) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
