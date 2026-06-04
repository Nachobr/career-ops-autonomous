#!/usr/bin/env node
/**
 * application-browser-assistant.mjs — visible browser application helper
 *
 * Task 5B MVP: detect common form fields, fill only low-risk factual fields,
 * skip sensitive/legal fields unless explicitly configured, and never click a
 * final submit button. Dry-run mode works from a saved HTML fixture without
 * opening a browser.
 */

import { chromium } from 'playwright';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve, basename } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createInterface } from 'readline';

const ROOT = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  reports: join(ROOT, 'reports'),
  cv: join(ROOT, 'cv.md'),
  profile: join(ROOT, 'config', 'profile.yml'),
  profileMode: join(ROOT, 'modes', '_profile.md'),
  out: join(ROOT, 'output', 'applications'),
};

const FINAL_SUBMIT_RE = /\b(submit|send application|complete application|enviar|postuler|bewerbung absenden)\b/i;
const APPLY_RE = /\b(apply|apply now)\b/i;
const SAFE_NEXT_RE = /\b(next|continue|save and continue)\b/i;
const SENSITIVE_RE = /\b(work authorization|authori[sz]ed|visa|sponsor|sponsorship|salary|compensation|expected pay|notice period|relocat|disability|veteran|gender|race|ethnicity|criminal|background check|date of birth|birthdate|ssn|social security)\b/i;
const SENSITIVE_IT_RE = /\b(autorizzato a lavorare|p\.iva|partita iva|enasarco|domicilio|indirizzo|taglia|privacy|informativa)\b/i;
const FREE_TEXT_RE = /\b(cover letter|why|motivation|additional information|tell us|anything else|summary)\b/i;
const SOURCE_RE = /\b(hear|source|referred|referral|where did you find|how did you find)\b/i;
const MAX_FORM_STEPS = 5;

function slugify(s) {
  return String(s || 'application').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'application';
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  const m = String(tag).match(new RegExp(`${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : '';
}

function labelsByFor(html) {
  const labels = new Map();
  for (const m of String(html).matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const id = attr(m[1], 'for');
    if (id) labels.set(id, stripTags(m[2]));
  }
  return labels;
}

function inlineLabelFor(html, index) {
  const before = html.slice(Math.max(0, index - 500), index);
  const m = before.match(/<label\b[^>]*>(?![\s\S]*<\/label>[\s\S]*<label\b)([\s\S]*?)$/i);
  return m ? stripTags(m[1]) : '';
}

function preferredSourceOption(options = [], preferred = '') {
  const pref = String(preferred || '').trim();
  if (pref) {
    const exact = options.find(o => o.toLowerCase() === pref.toLowerCase());
    if (exact) return exact;
    const partial = options.find(o => o.toLowerCase().includes(pref.toLowerCase()) || pref.toLowerCase().includes(o.toLowerCase()));
    if (partial) return partial;
  }
  return options.find(o => /linkedin/i.test(o))
      || options.find(o => /company|website|career/i.test(o))
      || options.find(o => /other/i.test(o))
      || options.find(o => String(o || '').trim())
      || pref
      || 'LinkedIn';
}

function optionMatching(options = [], patterns = []) {
  for (const pattern of patterns) {
    const found = options.find(o => pattern.test(String(o || '')));
    if (found) return found;
  }
  return '';
}

function preferredRelocationOption(options = [], configured = '') {
  const text = String(configured || '').trim();
  if (/yes|willing|relocat/i.test(text)) {
    const yes = optionMatching(options, [/^yes\b/i, /yes.*relocat|relocat.*yes|willing.*relocat|relocat/i]);
    if (yes) return yes;
  }
  const opt = optionMatching(options, [
    /remote/i,
    /yes.*relocat|relocat.*yes|willing.*relocat|relocat/i,
    /^yes\b/i,
  ]);
  if (opt) return opt;
  if (/yes|willing|relocat/i.test(text)) return 'Yes';
  if (/remote/i.test(text)) return 'Remote';
  return text || 'Yes';
}

function preferredOfficeLocation({ options = [], configured = '', reportContent = '', label = '' } = {}) {
  const text = [configured, reportContent, label].filter(Boolean).join('\n');
  const opt = optionMatching(options, [
    /london/i,
    /remote/i,
    /new york/i,
    /lausanne/i,
    /paris/i,
    /berlin/i,
    /madrid/i,
  ].filter(pattern => pattern.test(text)));
  if (opt) return opt;
  if (/london/i.test(text)) return 'London';
  if (/remote/i.test(configured)) return 'Remote';
  const city = String(configured || '').split(',')[0]?.trim();
  return city || 'London';
}

function isOfficeLocationQuestion(label) {
  return /office location|office locations|prefer(?:red)? to be based|where.*based/i.test(String(label || ''));
}

function isEnabled(value) {
  return value === true || /^(true|yes|y|1)$/i.test(String(value || '').trim());
}

function configuredRadioAction(field, configuredValue, reason) {
  const option = String(field.optionLabel || field.value || field.label || '');
  const wanted = String(configuredValue || '').trim();
  if (!wanted || !option) return null;
  const wantedYes = /^yes\b/i.test(wanted);
  const wantedNo = /^no\b/i.test(wanted);
  const optionYes = /^yes\b/i.test(option);
  const optionNo = /^no\b/i.test(option);
  const matches = option.toLowerCase().includes(wanted.toLowerCase())
    || wanted.toLowerCase().includes(option.toLowerCase())
    || (wantedYes && optionYes)
    || (wantedNo && optionNo);
  return matches ? { ...field, action: 'check', value: option, reason } : { ...field, action: 'skip', value: '', reason: 'radio choice does not match configured profile answer' };
}

export function detectFieldsFromHtml(html) {
  const labels = labelsByFor(html);
  const fields = [];
  const addField = (kind, tag, index, inner = '') => {
    const id = attr(tag, 'id');
    const name = attr(tag, 'name');
    const type = (attr(tag, 'type') || (kind === 'textarea' ? 'textarea' : kind)).toLowerCase();
    const label = labels.get(id) || attr(tag, 'aria-label') || attr(tag, 'placeholder') || inlineLabelFor(html, index) || name || id || type;
    fields.push({
      kind,
      type,
      id,
      name,
      label,
      required: /\brequired\b/i.test(tag),
      options: kind === 'select'
        ? [...inner.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)].map(o => stripTags(o[1])).filter(Boolean)
        : [],
    });
  };

  for (const m of String(html).matchAll(/<input\b([^>]*)>/gi)) {
    const type = (attr(m[1], 'type') || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset'].includes(type)) continue;
    addField('input', m[1], m.index || 0);
  }
  for (const m of String(html).matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    addField('textarea', m[1], m.index || 0, m[2]);
  }
  for (const m of String(html).matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    addField('select', m[1], m.index || 0, m[2]);
  }
  for (const m of String(html).matchAll(/<([a-z0-9-]+)\b([^>]*(?:role\s*=\s*['"]combobox['"]|aria-haspopup\s*=\s*['"]listbox['"]|class\s*=\s*['"][^'"]*(?:select__control|react-select|combobox)[^'"]*['"])[^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const label = attr(m[2], 'aria-label') || attr(m[2], 'placeholder') || inlineLabelFor(html, m.index || 0) || attr(m[2], 'id') || 'custom select';
    fields.push({ kind: 'custom-select', type: 'combobox', id: attr(m[2], 'id'), name: attr(m[2], 'name'), label, required: /\brequired\b/i.test(m[2]), options: [] });
  }
  for (const m of String(html).matchAll(/<(button)\b([^>]*)>([\s\S]*?)<\/button>|<input\b([^>]*type\s*=\s*['"]?submit[^>]*)>/gi)) {
    const tag = m[2] || m[4] || '';
    const label = stripTags(m[3] || attr(tag, 'value') || attr(tag, 'aria-label') || 'Submit');
    const finalSubmit = isFinalSubmitLabel(label);
    const reveal = !finalSubmit && APPLY_RE.test(label);
    fields.push({ kind: 'button', type: 'button', id: attr(tag, 'id'), name: attr(tag, 'name'), label, finalSubmit, reveal, safeNext: SAFE_NEXT_RE.test(label) && !finalSubmit && !reveal });
  }
  return fields;
}

export function isFinalSubmitLabel(label) {
  return FINAL_SUBMIT_RE.test(String(label || ''));
}

function parseArgs(argv) {
  const opts = { target: null, report: null, company: null, url: null, fixture: null, resume: null, coverLetter: null, dryRun: false, browser: true, llmAnswers: null, llmAnswerTokens: 700, debug: false, help: false, confirmSubmit: false };
  const valueFlags = new Set(['--report', '--company', '--url', '--fixture', '--resume', '--cover-letter', '--llm-answer-tokens']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--debug') opts.debug = true;
    else if (a === '--browser') opts.browser = true;
    else if (a === '--confirm-submit') opts.confirmSubmit = true;
    else if (a === '--llm-answers') opts.llmAnswers = true;
    else if (a === '--no-llm-answers') opts.llmAnswers = false;
    else if (a === '--llm-answer-tokens' && argv[i + 1]) opts.llmAnswerTokens = parseInt(argv[++i], 10);
    else if (a === '--report' && argv[i + 1]) opts.report = argv[++i];
    else if (a === '--company' && argv[i + 1]) opts.company = argv[++i];
    else if (a === '--url' && argv[i + 1]) opts.url = argv[++i];
    else if (a === '--fixture' && argv[i + 1]) opts.fixture = argv[++i];
    else if (a === '--resume' && argv[i + 1]) opts.resume = argv[++i];
    else if (a === '--cover-letter' && argv[i + 1]) opts.coverLetter = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else if (!opts.target && !valueFlags.has(argv[i - 1])) opts.target = a;
  }
  if (opts.target && !opts.report && !opts.company && !opts.url) {
    if (/^https?:\/\//i.test(opts.target) || /^file:/i.test(opts.target)) opts.url = opts.target;
    else if (/^\d+$/.test(opts.target)) opts.report = opts.target;
    else if (existsSync(opts.target)) opts.fixture = opts.target;
    else opts.company = opts.target;
  }
  if (!Number.isInteger(opts.llmAnswerTokens) || opts.llmAnswerTokens < 100) opts.llmAnswerTokens = 700;
  return opts;
}

function printHelp() {
  console.log(`application-browser-assistant — fill safe fields, stop before submit

Usage:
  career-ops apply <url|report|company> --browser [--dry-run]
  career-ops apply 657 --browser --fixture examples/apply-form-fixture.html --dry-run

Flags:
  --fixture <html>   Use a saved HTML fixture/page.
  --resume <pdf>     Attach this resume/CV file when a resume upload exists.
  --cover-letter <file> Attach this cover-letter file when a cover-letter upload exists.
  --llm-answers      Use configured LOCAL_LLM_* backend for free-text answers.
  --no-llm-answers   Disable LLM drafting; use deterministic fallback text.
  --llm-answer-tokens <n> Token cap for free-text answer drafting (default: 700).
  --debug            Print fill attempts and write a debug JSON audit.
  --confirm-submit   After you close the browser, ask "Did you submit?" — exit
                     code 10 means yes (used by \`review\` to mark Applied).
  --dry-run          Detect and propose only; no browser and no page changes.

In real browser mode, LLM free-text drafting is enabled automatically when
LOCAL_LLM_BASE_URL is configured. The assistant still never submits.
`);
}

async function loadYaml(path) {
  if (!existsSync(path)) return {};
  try {
    const yaml = (await import('js-yaml')).default;
    return yaml.load(readFileSync(path, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function profileValue(profile, keys) {
  for (const key of keys) {
    const parts = key.split('.');
    let cur = profile;
    for (const p of parts) cur = cur?.[p];
    if (cur) return String(cur);
  }
  return '';
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}

function findExistingPdf(paths) {
  for (const path of paths.filter(Boolean)) {
    if (existsSync(path)) return path;
  }
  return '';
}

function latestOutputCvPdf(fullName = '') {
  const dir = join(ROOT, 'output');
  if (!existsSync(dir)) return '';
  const nameSlug = slugify(fullName);
  const candidates = readdirSync(dir)
    .filter(f => /^cv-.*\.pdf$/i.test(f) && (/candidate/i.test(f) || f.includes(nameSlug)))
    .map(f => {
      const path = join(dir, f);
      let mtime = 0;
      try { mtime = statSync(path).mtimeMs; } catch {}
      const priority = f === `cv-${nameSlug}.pdf` ? 3 : f.includes(nameSlug) ? 2 : 1;
      return { path, mtime, priority };
    });
  return candidates.sort((a, b) => b.priority - a.priority || b.mtime - a.mtime)[0]?.path || '';
}

function canonicalResumePdf(fullName = '') {
  const canonical = join(ROOT, 'output', `cv-${slugify(fullName)}.pdf`);
  if (existsSync(canonical)) return canonical;
  const source = latestOutputCvPdf(fullName);
  if (!source) return '';
  try {
    copyFileSync(source, canonical);
    return canonical;
  } catch {
    return '';
  }
}

function pdfPathFromReport(report = {}) {
  const pdf = String(report.pdf || '').trim();
  if (!pdf || /^(pending|none|n\/a|-)/i.test(pdf)) return '';
  return resolve(ROOT, pdf);
}

function reportMeta(reportFile, reportContent) {
  const title = reportContent.match(/^#\s*(?:Evaluation|Evaluación):\s*(.+?)\s+[—-]\s+(.+)$/m);
  const url = reportContent.match(/^\*\*URL:\*\*\s*(\S+)/m);
  const score = reportContent.match(/^\*\*Score:\*\*\s*(.+)$/m);
  const pdf = reportContent.match(/^\*\*PDF:\*\*\s*(.+)$/m);
  return {
    reportFile,
    reportNum: reportFile ? (reportFile.match(/^(\d{3})-/)?.[1] || null) : null,
    company: title?.[1]?.trim() || (reportFile ? basename(reportFile).replace(/^\d{3}-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '') : 'Unknown'),
    role: title?.[2]?.trim() || 'Unknown role',
    url: url?.[1] || '',
    score: score?.[1] || '',
    pdf: pdf?.[1] || '',
  };
}

function findReport(opts) {
  if (!existsSync(PATHS.reports)) return { reportFile: '', reportContent: '', meta: reportMeta('', '') };
  let file = '';
  if (opts.report) {
    file = readdirSync(PATHS.reports).find(f => f.startsWith(String(opts.report).padStart(3, '0')) && f.endsWith('.md')) || '';
  } else if (opts.company) {
    file = readdirSync(PATHS.reports).find(f => f.toLowerCase().includes(String(opts.company).toLowerCase()) && f.endsWith('.md')) || '';
  } else if (opts.url) {
    const norm = u => String(u).replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
    file = readdirSync(PATHS.reports).find(f => {
      if (!f.endsWith('.md')) return false;
      const body = readFileSync(join(PATHS.reports, f), 'utf-8');
      const m = body.match(/^\*\*URL:\*\*\s*(\S+)/m);
      return m && (m[1] === opts.url || norm(m[1]) === norm(opts.url));
    }) || '';
  }
  const reportContent = file ? readFileSync(join(PATHS.reports, file), 'utf-8') : '';
  return { reportFile: file, reportContent, meta: reportMeta(file, reportContent) };
}

export function proposeAnswers(fields, { profile = {}, report = {}, reportContent = '', cv = '', uploadPaths = {} } = {}) {
  const fullName = profileValue(profile, ['candidate.full_name', 'name']);
  const { first, last } = splitName(fullName);
  const appAnswers = profile.application_answers || {};
  const resumePdf = findExistingPdf([
    uploadPaths.resume ? resolve(ROOT, uploadPaths.resume) : '',
    canonicalResumePdf(fullName),
  ]);
  const coverLetterFile = findExistingPdf([
    uploadPaths.coverLetter ? resolve(ROOT, uploadPaths.coverLetter) : '',
    join(ROOT, 'output', `cover-letter-${slugify(fullName)}-${slugify(report.company)}.pdf`),
  ]);
  const safe = [
    [/\bnome\b/i, first],
    [/\bcognome\b/i, last],
    [/\be-?mail\b/i, profileValue(profile, ['candidate.email', 'email'])],
    [/\btelefono\b/i, profileValue(profile, ['candidate.phone', 'phone'])],
    [/\bpaese\b/i, profileValue(profile, ['location.country'])],
    [/\b(posizione|citt[aà])\b/i, profileValue(profile, ['location.city', 'candidate.city'])],
    [/\bfirst[\s_-]*name\b/i, first],
    [/\blast[\s_-]*name\b/i, last],
    [/\b(full )?name\b/i, fullName],
    [/\bemail\b/i, profileValue(profile, ['candidate.email', 'email'])],
    [/\bphone|mobile\b/i, profileValue(profile, ['candidate.phone', 'phone'])],
    [/\blinkedin\b/i, profileValue(profile, ['candidate.linkedin', 'candidate.inkedin', 'linkedin'])],
    [/\bgithub\b/i, profileValue(profile, ['candidate.github', 'github'])],
    [/\bportfolio|website|personal site\b/i, profileValue(profile, ['candidate.portfolio_url', 'candidate.website', 'portfolio_url'])],
    [/\bcity\b/i, profileValue(profile, ['location.city', 'candidate.city'])],
    [/\bcountry\b/i, profileValue(profile, ['location.country'])],
    [/\blocation\b/i, profileValue(profile, ['candidate.location', 'location.city'])],
  ];
  const fallbackFreeText = (fieldLabel = '') => {
    const company = report.company && !/^unknown/i.test(report.company) ? report.company : 'the company';
    const role = report.role && !/^unknown/i.test(report.role) ? report.role : 'this role';
    if (/why\s+hume|why.*company|why.*join|why.*interested/i.test(fieldLabel)) {
      if (/hume/i.test(company) || /hume/i.test(fieldLabel)) {
        return 'Hume is interesting to me because it is working on a more human layer of AI: understanding expression, emotion, and communication, not just generating text. I like roles where product, data, and AI come together in a way that can become genuinely useful for people, and my background building full-stack AI products gives me a practical way to contribute. I would bring a builder mindset, strong technical curiosity, and the ability to turn ambiguous ideas into working product quickly.';
      }
      return `I’m interested in ${company} because ${role} looks like a place where I can combine product judgment with hands-on AI/software execution. I enjoy taking ambiguous problems, building practical systems, and iterating until they are useful for real users. That is the kind of work where I do my best work.`;
    }
    return `I’m interested in ${role} because it matches the kind of work I enjoy most: building practical AI/software products end to end, collaborating across product and engineering, and turning ambiguous ideas into usable systems. My background in full-stack development, AI workflows, and product-minded execution would let me contribute quickly while continuing to learn from the team.`;
  };

  // A gated posting (e.g. Ashby/Greenhouse) shows the job description plus an
  // "Apply for this Job" button, and only reveals the real form fields after
  // it is clicked. Detect whether any fillable field is already present so we
  // only click the reveal button when the form is still hidden.
  const hasFillableField = fields.some(f => f.kind && f.kind !== 'button');

  return fields.map(field => {
    if (field.kind === 'button') {
      if (field.finalSubmit) return { ...field, action: 'stop', value: '', reason: 'final submit button detected — never clicked' };
      if (field.safeNext) return { ...field, action: 'next', value: '', reason: 'safe navigation button; clicked only to reveal the next form step' };
      if (field.reveal) {
        return hasFillableField
          ? { ...field, action: 'ignore', value: '', reason: 'apply button ignored — form fields are already visible' }
          : { ...field, action: 'reveal', value: '', reason: 'apply button clicked once to reveal the gated application form' };
      }
      return { ...field, action: 'ignore', value: '', reason: 'button ignored' };
    }
    const label = `${field.label || ''} ${field.name || ''} ${field.id || ''}`;
    const salaryAnswer = appAnswers.salary_expectations || profileValue(profile, ['compensation.target_range']);
    if (/future job openings|email me about future/i.test(label)) {
      const value = appAnswers.future_job_openings || 'Yes';
      return { ...field, action: 'fill', value, alternatives: ['Yes', 'No'], forceFill: true, reason: 'configured future-job-openings preference from profile' };
    }
    if (SOURCE_RE.test(label) && !['radio', 'checkbox'].includes(field.type)) {
      return { ...field, action: 'fill', value: preferredSourceOption(field.options, appAnswers.source), alternatives: ['LinkedIn', 'LinkedIn / Social Media', 'Social Media', 'Job board', 'Other'], forceFill: true, reason: 'configured source answer from profile' };
    }
    if (/current location/i.test(label)) {
      const currentLocation = appAnswers.current_location || profileValue(profile, ['candidate.location', 'location.city']);
      return { ...field, action: 'fill', value: currentLocation, alternatives: ['Córdoba, Argentina', 'Cordoba, Córdoba, Argentina', 'Argentina', 'Buenos Aires, Argentina', 'Remote'], forceFill: true, reason: 'configured current-location answer from profile' };
    }
    if (/legally authori[sz]ed.*united states.*without sponsorship|united states.*without sponsorship/i.test(label)) {
      const value = appAnswers.us_work_authorization_without_sponsorship || appAnswers.work_authorization || 'No';
      return { ...field, action: 'fill', value, alternatives: ['No', 'Yes'], forceFill: true, reason: 'configured US work-authorization answer from profile' };
    }
    if (/authori[sz]ed to work|work authori[sz]ation/i.test(label) && appAnswers.work_authorization) {
      return { ...field, action: 'fill', value: appAnswers.work_authorization, alternatives: ['No', 'Yes'], forceFill: true, reason: 'configured work authorization answer from profile' };
    }
    if (/applied.*positions?.*past\s*6\s*months|past\s*6\s*months.*applied/i.test(label)) {
      const value = appAnswers.applied_past_6_months || appAnswers.applied_to_company_past_6_months || 'No';
      return { ...field, action: 'fill', value, alternatives: ['No', 'Yes'], forceFill: true, reason: 'configured recent-application history answer from profile' };
    }
    if (/previously worked for|worked for .*\?/i.test(label) && appAnswers.previously_worked_company) {
      return { ...field, action: 'fill', value: appAnswers.previously_worked_company, alternatives: ['No', 'Yes'], forceFill: true, reason: 'configured previous-employer answer from profile' };
    }
    if (/current or most recent company|most recent company/i.test(label) && appAnswers.current_or_recent_company) {
      return { ...field, action: 'fill', value: appAnswers.current_or_recent_company, reason: 'configured recent-company answer from profile' };
    }
    if (/hybrid|in-office|3 days per week|work from our office/i.test(label) && appAnswers.hybrid_office_3_days) {
      return { ...field, action: 'fill', value: appAnswers.hybrid_office_3_days, alternatives: ['Yes', 'No'], forceFill: true, reason: 'configured hybrid-office answer from profile' };
    }
    if (/salary|compensation|expected pay|package/i.test(label) && salaryAnswer) return { ...field, action: 'fill', value: salaryAnswer, reason: 'configured salary expectation from profile' };
    if (/notice period/i.test(label) && appAnswers.notice_period) return { ...field, action: 'fill', value: appAnswers.notice_period, reason: 'configured notice period from profile' };
    if (isOfficeLocationQuestion(label)) {
      const officeLocation = preferredOfficeLocation({
        options: field.options,
        configured: appAnswers.office_location || appAnswers.preferred_office_location || profileValue(profile, ['location.city', 'candidate.location']),
        reportContent,
        label,
      });
      if (['select', 'custom-select'].includes(field.kind) || field.role === 'combobox') {
        return { ...field, action: 'fill', value: officeLocation, alternatives: ['London', 'Remote'], forceFill: true, reason: 'configured/inferred office location select answer' };
      }
      return { ...field, action: 'fill', value: officeLocation, forceFill: true, reason: 'configured/inferred office location answer' };
    }
    if (/relocat|based in .*office|willing to.*(london|office)|live in and around/i.test(label) && appAnswers.london_relocation) {
      if (field.type === 'radio') return configuredRadioAction(field, appAnswers.london_relocation, 'configured relocation/location answer from profile') || { ...field, action: 'skip', value: '', reason: 'radio choice requires user confirmation' };
      if (['select', 'custom-select'].includes(field.kind) || field.role === 'combobox') {
        return { ...field, action: 'fill', value: preferredRelocationOption(field.options, appAnswers.london_relocation), alternatives: ['Yes', 'No', 'Remote', 'willing to relocate', 'relocate'], forceFill: true, reason: 'configured relocation/location select answer from profile' };
      }
      return { ...field, action: 'fill', value: appAnswers.london_relocation, reason: 'configured relocation/location answer from profile' };
    }
    if (SENSITIVE_RE.test(label) || SENSITIVE_IT_RE.test(label)) return { ...field, action: 'skip', value: '', reason: 'sensitive/legal/personal field requires explicit user decision' };
    if (field.type === 'file') {
      if (/cover.?letter|lettera/i.test(label)) {
        if (coverLetterFile) return { ...field, action: 'upload', value: coverLetterFile, reason: 'attach cover-letter file' };
        return { ...field, action: 'skip', value: '', reason: 'cover-letter upload detected but no cover-letter file provided' };
      }
      if (/resume|curriculum|cv/i.test(label) && resumePdf) return { ...field, action: 'upload', value: resumePdf, reason: 'attach generated CV PDF from report/output' };
      return { ...field, action: 'skip', value: '', reason: /resume|curriculum|cv/i.test(label) ? 'CV upload detected but no generated PDF found for this report' : 'file upload skipped; upload manually if needed' };
    }
    if (field.type === 'checkbox') {
      const option = field.optionLabel || field.value || field.label || '';
      if (/point of data transfer|data transfer/i.test(label) && isEnabled(appAnswers.point_of_data_transfer_acknowledge)) {
        return { ...field, action: 'check', value: option || 'Acknowledge', reason: 'configured point-of-data-transfer acknowledgement from profile' };
      }
      if (/ai tools|assistants during the interview|interview and assessment/i.test(label) && isEnabled(appAnswers.confirm_no_ai_interview_tools)) {
        return { ...field, action: 'check', value: option || 'confirmed', reason: 'configured interview AI-tools attestation from profile' };
      }
      if (/linkedin/i.test(option) && /linkedin/i.test(appAnswers.source || 'LinkedIn')) return { ...field, action: 'check', value: option, reason: 'configured source checkbox from profile' };
      return { ...field, action: 'skip', value: '', reason: 'checkbox requires user confirmation' };
    }
    if (field.type === 'radio') {
      const option = field.optionLabel || field.value || field.label || '';
      if ((SOURCE_RE.test(label) || /linkedin/i.test(option)) && /linkedin|other/i.test(option) && /linkedin/i.test(appAnswers.source || 'LinkedIn')) return { ...field, action: 'check', value: option, reason: 'configured source radio option from profile' };
      return { ...field, action: 'skip', value: '', reason: 'radio choice requires user confirmation' };
    }
    for (const [re, value] of safe) {
      if (re.test(label) && value) return { ...field, action: 'fill', value, reason: 'low-risk factual profile field' };
    }
    if (field.kind === 'textarea' || FREE_TEXT_RE.test(label)) return { ...field, action: 'fill', value: fallbackFreeText(label), reason: 'draft free-text answer from report/CV context' };
    if (['select', 'custom-select'].includes(field.kind) && SOURCE_RE.test(label)) return { ...field, action: 'fill', value: preferredSourceOption(field.options, appAnswers.source), reason: 'configured source dropdown from profile' };
    return { ...field, action: 'skip', value: '', reason: 'unknown field; left for user review' };
  });
}

function shouldUseLlmAnswers(opts = {}) {
  if (opts.llmAnswers === false) return false;
  if (opts.llmAnswers === true) return Boolean(process.env.LOCAL_LLM_BASE_URL);
  // Avoid network calls in dry-run/tests unless explicitly requested.
  return !opts.dryRun && Boolean(process.env.LOCAL_LLM_BASE_URL);
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function compactText(text, maxChars) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function looksSpanish(text) {
  const s = String(text || '').toLowerCase();
  const hits = (s.match(/\b(como|porque|experiencia|desarrollo|habilidades|proyectos|innovadores|adem[aá]s|soluciones|tecnolog[ií]a|sociedad|ingeniero)\b/g) || []).length;
  return /[ñáéíóú]/i.test(s) || hits >= 3;
}

function looksMetaOrAiLike(text) {
  const s = String(text || '').toLowerCase();
  return /provided cv|cv excerpt|specific information|if you provide|i do not have|i don't have|as an ai|based on the provided|tailor my response/i.test(s);
}

async function draftFreeTextAnswers(proposals, { profile = {}, report = {}, reportContent = '', cv = '', opts = {} } = {}) {
  if (!shouldUseLlmAnswers(opts)) return proposals;
  const targets = proposals
    .map((p, index) => ({ index, proposal: p }))
    .filter(({ proposal }) => proposal.action === 'fill' && proposal.reason === 'draft free-text answer from report/CV context');
  if (!targets.length) return proposals;

  const baseUrl = process.env.LOCAL_LLM_BASE_URL.replace(/\/$/, '');
  const model = process.env.LOCAL_LLM_MODEL || 'Qwen/Qwen2.5-3B-Instruct';
  const apiKey = process.env.LOCAL_LLM_API_KEY || 'none';
  const maxTokens = opts.llmAnswerTokens || 700;
  const questions = targets.map(({ index, proposal }) => ({
    id: String(index),
    label: proposal.label || proposal.name || proposal.id || 'free-text question',
  }));

  const system = [
    'You draft job application free-text answers for the candidate.',
    'Always answer in English unless the question itself is not in English. If the CV/profile contains Spanish, translate and summarize the relevant facts in English.',
    'Never mention the prompt, the CV excerpt, missing context, or phrases like "if you provide more details". Write as the candidate in first person.',
    'Use only the provided CV/profile/report facts. Do not invent metrics, employers, referrals, credentials, or work authorization facts.',
    'Keep answers concise, warm, specific, professional, and ready to paste into a form. Avoid generic AI-sounding wording.',
    'Return only valid JSON: {"answers":{"<id>":"answer text"}}.',
  ].join('\n');
  const user = JSON.stringify({
    company: report.company || 'Unknown',
    role: report.role || 'Unknown',
    score: report.score || '',
    profile: {
      name: profileValue(profile, ['candidate.name', 'name']),
      location: profileValue(profile, ['candidate.location', 'location.city']),
      target: profileValue(profile, ['targeting.roles', 'roles']),
    },
    cv_excerpt: compactText(cv, 3500),
    report_excerpt: compactText(reportContent, 4500),
    questions,
  });

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const parsed = extractJsonObject(data?.choices?.[0]?.message?.content);
    const answers = parsed?.answers || {};
    let changed = 0;
    const next = proposals.map((proposal, index) => {
      const answer = answers[String(index)];
      if (!answer || typeof answer !== 'string' || looksSpanish(answer) || looksMetaOrAiLike(answer)) return proposal;
      changed++;
      return { ...proposal, value: answer.trim(), reason: `LLM-drafted free-text answer via ${baseUrl.includes('ngrok') ? 'colab/ngrok' : 'configured LOCAL_LLM backend'}` };
    });
    if (changed) console.log(`🤖 drafted ${changed} free-text answer(s) with ${baseUrl.includes('ngrok') ? 'colab/ngrok' : 'configured LOCAL_LLM backend'} (${model})`);
    return next;
  } catch (err) {
    console.log(`⚠ LLM free-text drafting unavailable (${err.message}); using deterministic fallback.`);
    return proposals;
  }
}

function renderAudit({ meta, proposals, dryRun, target }) {
  const lines = [
    `# Application draft audit — ${meta.company} — ${meta.role}`,
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**Target:** ${target || meta.url || '-'}`,
    `**Report:** ${meta.reportFile || '-'}`,
    `**Dry run:** ${dryRun ? 'yes' : 'no'}`,
    '',
    'This assistant never submits applications. Review all fields manually before clicking any final submit button.',
    '',
    '| Field | Action | Status | Reason | Proposed value |',
    '|---|---|---|---|---|',
  ];
  for (const p of proposals) {
    const value = p.value ? String(p.value).replace(/\s+/g, ' ').slice(0, 180) : '';
    const status = p.needsReview ? 'needs review' : p.fillStatus || '';
    lines.push(`| ${p.label || p.name || p.id || p.kind} | ${p.action} | ${status} | ${p.reason || ''} | ${value} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function writeAudit(meta, proposals, opts) {
  mkdirSync(PATHS.out, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const prefix = meta.reportNum || 'draft';
  const path = join(PATHS.out, `${prefix}-${slugify(meta.company)}-${date}.md`);
  writeFileSync(path, renderAudit({ meta, proposals, dryRun: opts.dryRun, target: opts.fixture || opts.url || opts.target }), 'utf-8');
  return path;
}

function writeDebugAudit(meta, fields, proposals, debugEvents, opts) {
  mkdirSync(PATHS.out, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const prefix = meta.reportNum || 'draft';
  const path = join(PATHS.out, `${prefix}-${slugify(meta.company)}-${date}.debug.json`);
  writeFileSync(path, JSON.stringify({
    date: new Date().toISOString(),
    target: opts.fixture || opts.url || opts.target || meta.url || null,
    report: meta.reportFile || null,
    options: {
      dryRun: opts.dryRun,
      llmAnswers: opts.llmAnswers,
      llmAnswerTokens: opts.llmAnswerTokens,
    },
    fields,
    proposals,
    fillEvents: debugEvents,
  }, null, 2), 'utf-8');
  return path;
}

function debugEvent(context, event) {
  if (!context?.opts?.debug) return;
  context.debugEvents ||= [];
  context.debugEvents.push({ ts: new Date().toISOString(), ...event });
}

function fillOutcome(context, event) {
  context.fillOutcomes ||= [];
  context.fillOutcomes.push({ ts: new Date().toISOString(), ...event });
  debugEvent(context, event);
}

function debugPrint(opts, msg) {
  if (opts?.debug) console.log(`DEBUG ${msg}`);
}

async function htmlForDryRun(opts) {
  if (opts.fixture) return readFileSync(opts.fixture, 'utf-8');
  if (opts.url && /^file:/i.test(opts.url)) return readFileSync(new URL(opts.url), 'utf-8');
  if (opts.url && /^https?:\/\//i.test(opts.url)) {
    const res = await fetch(opts.url, { headers: { 'user-agent': 'career-ops/1.0' } });
    return await res.text();
  }
  throw new Error('dry-run browser mode needs --fixture, file: URL, or http(s) URL');
}

async function detectFieldsFromPage(page) {
  const detectInFrame = async (frame, frameIndex) => frame.evaluate(({ frameIndex }) => {
    const finalRe = /\b(submit|send application|complete application|enviar|postuler|bewerbung absenden)\b/i;
    const applyRe = /\b(apply|apply now)\b/i;
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const cssPath = (el) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      for (const attr of ['data-testid', 'data-test', 'data-qa', 'aria-label']) {
        const value = el.getAttribute(attr);
        if (value) return `[${attr}="${CSS.escape(value)}"]`;
      }
      if (el.name && el.value && ['radio', 'checkbox'].includes((el.getAttribute('type') || '').toLowerCase())) {
        return `[name="${CSS.escape(el.name)}"][value="${CSS.escape(el.value)}"]`;
      }
      if (el.name) return `[name="${CSS.escape(el.name)}"]`;
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
        const tag = cur.tagName.toLowerCase();
        const parent = cur.parentElement;
        if (!parent) { parts.unshift(tag); break; }
        const siblings = [...parent.children].filter(s => s.tagName === cur.tagName);
        const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(cur) + 1})` : '';
        parts.unshift(`${tag}${nth}`);
        if (['form', 'main', 'section'].includes(tag) || cur.id) break;
        cur = parent;
      }
      return parts.join(' > ');
    };
    const appContextFor = (el) => {
      const container = el.closest('form,#grnhse_app,#application-form,[id*="application" i],[class*="application" i],[data-selector*="application" i],[data-qa*="application" i],[data-testid*="application" i],[class*="ashby" i],[class*="lever" i],[class*="workday" i],[class*="smartrecruiters" i],[class*="workable" i]');
      return !!container || /\b(greenhouse\.io|lever\.co|ashbyhq\.com|workdayjobs\.com|myworkdayjobs\.com|smartrecruiters\.com|workable\.com)\b/i.test(window.location.hostname);
    };
    const labelFor = (el) => {
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab?.innerText?.trim()) return lab.innerText.trim();
      }
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText?.trim()).filter(Boolean).join(' ');
        if (text) return text;
      }
      const wrap = el.closest('label');
      if (wrap?.innerText?.trim()) return wrap.innerText.trim();
      const field = el.closest('.field-wrapper,.input-wrapper,.select__container,.ashby-application-form-field-entry,[data-qa="input"],[data-testid*="field" i],[role="group"],fieldset');
      const fieldLabel = field?.querySelector('label,legend,[data-qa="label"],[class*="label" i]')?.innerText?.trim();
      if (fieldLabel) return fieldLabel;
      return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || el.type || el.tagName.toLowerCase();
    };
    const radioGroupLabelFor = (el) => {
      const group = el.closest('fieldset,[role="radiogroup"],[role="group"],.field-wrapper,.ashby-application-form-field-entry');
      return group?.querySelector('legend,label,[class*="label" i]')?.innerText?.trim() || '';
    };
    const fields = [];
    for (const el of document.querySelectorAll('input, textarea, select')) {
      const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
      if (['hidden', 'submit', 'button', 'reset'].includes(type)) continue;
      if (!isVisible(el)) continue;
      const optionLabel = ['radio', 'checkbox'].includes(type) ? labelFor(el) : '';
      const groupLabel = ['radio', 'checkbox'].includes(type) ? radioGroupLabelFor(el) : '';
      const label = ['radio', 'checkbox'].includes(type)
        ? [groupLabel, optionLabel].filter(Boolean).join(' ').trim()
        : labelFor(el);
      fields.push({
        kind: el.tagName.toLowerCase(),
        type,
        role: el.getAttribute('role') || '',
        id: el.id || '',
        name: el.name || '',
        value: el.value || '',
        label: label || '',
        optionLabel,
        required: el.required,
        selector: cssPath(el),
        frameIndex,
        options: el.tagName.toLowerCase() === 'select' ? [...el.options].map(o => o.text).filter(Boolean) : [],
      });
    }
    const customSelects = document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [class*="select__control"], [class*="react-select"], [data-testid*="select" i], [data-qa*="select" i]');
    for (const el of customSelects) {
      if (!isVisible(el)) continue;
      if (['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())) continue;
      if (el.querySelector('input[role="combobox"][id], input[id]')) continue;
      const label = labelFor(el);
      const optionContainer = el.closest('[role="group"],fieldset,.field-wrapper,.select__container,.ashby-application-form-field-entry') || document;
      const options = [...optionContainer.querySelectorAll('[role="option"], option, [data-value], [class*="option" i]')]
        .map(o => (o.innerText || o.textContent || o.getAttribute('data-value') || '').trim())
        .filter(Boolean);
      fields.push({ kind: 'custom-select', type: 'combobox', role: el.getAttribute('role') || 'combobox', id: el.id || '', name: el.getAttribute('name') || '', label, required: el.getAttribute('aria-required') === 'true', selector: cssPath(el), frameIndex, options });
    }
    for (const el of document.querySelectorAll('button, input[type="submit"]')) {
      if (!isVisible(el)) continue;
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      const appContext = appContextFor(el);
      const finalSubmit = finalRe.test(label);
      // "Apply" / "Apply for this Job" on a job posting opens (reveals) the
      // gated application form — it is NOT the final submit. We may click it
      // once, but only when no fillable fields are visible yet (see
      // proposeAnswers), so single-page forms are never submitted by accident.
      const reveal = !finalSubmit && appContext && applyRe.test(label);
      fields.push({ kind: 'button', type: 'button', id: el.id || '', name: el.name || '', label, finalSubmit, reveal, safeNext: /\b(next|continue|save and continue)\b/i.test(label) && !finalSubmit && !reveal, selector: cssPath(el), frameIndex });
    }
    return fields;
  }, { frameIndex }).catch(() => []);

  const results = [];
  for (const [frameIndex, frame] of page.frames().entries()) {
    results.push(...await detectInFrame(frame, frameIndex));
  }
  return results;
}

async function fillCustomSelect(frame, loc, value) {
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapeCss = (s) => String(s).replace(/([#.;?+*~':"!^$[\]()=>|/@])/g, '\\$1');
  const exactRe = new RegExp(`^\\s*${escapeRe(value)}(?:\\s|$|\\()`, 'i');
  const looseRe = new RegExp(escapeRe(value), 'i');
  await loc.click({ timeout: 1500 }).catch(() => {});
  const nestedInput = loc.locator('input[role="combobox"], input').first();
  const input = await nestedInput.count().catch(() => 0) ? nestedInput : loc;

  const clickVisibleOption = async (re, preferScoped = true) => {
    const controls = await input.evaluate((el) => el.getAttribute('aria-controls') || '').catch(() => '');
    if (preferScoped && controls) {
      const scoped = frame.locator(`#${escapeCss(controls)} [role="option"], #${escapeCss(controls)} [id*="option"], #${escapeCss(controls)} [class*="option" i]`).filter({ hasText: re }).first();
      if (await scoped.count().catch(() => 0)) {
        await scoped.click({ timeout: 1500 }).catch(() => {});
        return true;
      }
    }
    const roleOption = frame.getByRole('option', { name: re }).first();
    if (await roleOption.count().catch(() => 0)) {
      await roleOption.click({ timeout: 1500 }).catch(() => {});
      return true;
    }
    const listOption = frame.locator('[role="option"], [id*="option"], [class*="option" i]').filter({ hasText: re }).first();
    if (await listOption.count().catch(() => 0)) {
      await listOption.click({ timeout: 1500 }).catch(() => {});
      return true;
    }
    return false;
  };

  if (await clickVisibleOption(exactRe)) return true;
  if (await clickVisibleOption(looseRe)) return true;
  await input.fill(String(value)).catch(() => {});
  await frame.page().waitForTimeout(500).catch(() => {});

  if (await clickVisibleOption(exactRe)) return true;
  if (await clickVisibleOption(looseRe)) return true;
  await input.press('ArrowDown').catch(() => {});
  await input.press('Enter').catch(() => {});
  return false;
}

async function selectNativeOption(loc, proposal) {
  const candidates = [proposal.value, ...(proposal.alternatives || [])].filter(Boolean);
  for (const candidate of candidates) {
    const ok = await loc.selectOption({ label: candidate }).then(() => true).catch(() => false);
    if (ok) return true;
  }
  for (const candidate of candidates) {
    const ok = await loc.selectOption({ value: candidate }).then(() => true).catch(() => false);
    if (ok) return true;
  }
  return loc.selectOption({ index: 1 }).then(() => true).catch(() => false);
}

async function fillCustomSelectWithFallbacks(frame, loc, proposal) {
  const candidates = [proposal.value, ...(proposal.alternatives || [])].filter(Boolean);
  for (const candidate of candidates) {
    if (await fillCustomSelect(frame, loc, candidate).catch(() => false)) return true;
    const exactOption = frame.getByRole('option', { name: new RegExp(String(candidate).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
    if (await exactOption.count().catch(() => 0)) {
      await exactOption.click({ timeout: 1500 }).catch(() => {});
      return true;
    }
    const textOption = frame.getByText(new RegExp(String(candidate).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first();
    if (await textOption.count().catch(() => 0)) {
      await textOption.click({ timeout: 1500 }).catch(() => {});
      return true;
    }
  }
  return false;
}

function isPlaceholderValue(value) {
  return /^(select|select\.\.\.|choose|choose\.\.\.|please select|-)$/i.test(String(value || '').trim());
}

async function fieldState(loc) {
  return loc.evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || '',
    role: el.getAttribute('role') || '',
    value: 'value' in el ? el.value : '',
    text: (el.innerText || el.textContent || '').trim().slice(0, 300),
    ariaExpanded: el.getAttribute('aria-expanded') || '',
    ariaControls: el.getAttribute('aria-controls') || '',
    selectedText: el.tagName.toLowerCase() === 'select'
      ? (el.options[el.selectedIndex]?.text || '')
      : '',
    options: el.tagName.toLowerCase() === 'select'
      ? [...el.options].map(o => ({ text: o.text, value: o.value, selected: o.selected })).slice(0, 50)
      : [],
  })).catch((err) => ({ error: err.message }));
}

async function visibleSelectVerification(loc, expected) {
  return loc.evaluate((el, expected) => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const value = clean('value' in el ? el.value : '');
    const control = el.closest('.select__control,[class*="select__control" i],[role="combobox"]') || el.parentElement;
    const field = el.closest('.field-wrapper,.ashby-application-form-field-entry,.input-wrapper,[data-qa="input"],[data-testid*="field" i],fieldset,[role="group"]');
    const selectedNodes = [control, field, el.parentElement].filter(Boolean).flatMap(c => [
      ...c.querySelectorAll('[class*="single-value" i],[class*="multi-value__label" i],[aria-selected="true"],[data-value]'),
    ]);
    const selectedText = clean(selectedNodes.map(n => n.innerText || n.textContent || n.getAttribute('data-value') || '').filter(Boolean).join(' '));
    const controlText = clean(control && (control.innerText || control.textContent || ''));
    const fieldText = clean(field && (field.innerText || field.textContent || ''));
    const ownText = clean(el.innerText || el.textContent || '');
    const visibleText = selectedText || controlText || ownText;
    const expectedText = clean(expected).toLowerCase();
    const expanded = el.getAttribute('aria-expanded') === 'true';
    const unresolvedText = [visibleText, fieldText].join(' ');
    const unresolved = expanded || /\b0 results\b|\bno options\b|this field is required|select\.\.\.|please select/i.test(unresolvedText);
    const visibleOk = expectedText && visibleText.toLowerCase().includes(expectedText) && !unresolved;
    const valueOk = expectedText && value.toLowerCase().includes(expectedText) && !unresolved;
    return { ok: visibleOk || valueOk, visibleOk, valueOk, expected: clean(expected), value, visibleText, selectedText, controlText, fieldText, expanded, unresolved };
  }, String(expected || '')).catch((err) => ({ ok: false, error: err.message, expected: String(expected || '') }));
}

async function verifyTextValue(loc, expected) {
  const actual = await loc.inputValue().catch(() => null);
  if (actual == null) return { ok: false, actual: '', expected: String(expected || '') };
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const a = norm(actual);
  const e = norm(expected);
  // Value "stuck" if the field is non-empty and matches (or contains) what we typed.
  const ok = !!a && (a === e || a.includes(e) || e.includes(a));
  return { ok, actual, expected: String(expected || '') };
}

async function checkControl(frame, loc, proposal) {
  const isChecked = async () => loc.isChecked().catch(() => false);
  if (await isChecked()) return true;

  await loc.check({ timeout: 1500, force: true }).catch(() => {});
  if (await isChecked()) return true;

  await loc.click({ timeout: 1500, force: true }).catch(() => {});
  if (await isChecked()) return true;

  return frame.evaluate(({ selector, id }) => {
    const el = document.querySelector(selector);
    if (!el) return false;

    const before = !!el.checked;
    const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrappingLabel = el.closest('label');
    const clickable = label || wrappingLabel || el.parentElement || el;
    clickable.click();

    if (!el.checked) {
      el.checked = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return !before && !!el.checked || !!el.checked;
  }, { selector: proposal.selector, id: proposal.id || '' }).catch(() => false);
}

async function fillPage(page, proposals, context = {}) {
  const frames = page.frames();
  let changed = false;
  for (const p of proposals) {
    if (!['fill', 'upload', 'check'].includes(p.action) || !p.selector || (p.action !== 'check' && !p.value)) continue;
    const frame = Number.isInteger(p.frameIndex) ? frames[p.frameIndex] : page.mainFrame();
    if (!frame) continue;
    const loc = frame.locator(p.selector).first();
    if (await loc.count() === 0) {
      fillOutcome(context, { phase: 'fill', status: 'missing-selector', selector: p.selector, label: p.label || p.name || p.id || '', action: p.action, value: p.value || '', needsReview: true, key: proposalKey(p) });
      continue;
    }
    const before = context?.opts?.debug ? await fieldState(loc) : null;
    if (p.action === 'upload') {
      let ok = false;
      let error = '';
      await loc.setInputFiles(p.value).then(() => { changed = true; ok = true; }).catch((err) => { error = err.message; });
      fillOutcome(context, { phase: 'fill', action: p.action, status: ok ? 'ok' : 'failed', selector: p.selector, label: p.label || p.name || p.id || '', value: p.value || '', before, error, needsReview: !ok, key: proposalKey(p) });
      continue;
    }
    if (p.action === 'check') {
      let ok = false;
      let error = '';
      try { ok = await checkControl(frame, loc, p); } catch (err) { error = err.message; }
      if (ok) changed = true;
      const after = context?.opts?.debug ? await fieldState(loc) : null;
      fillOutcome(context, { phase: 'fill', action: p.action, status: ok ? 'ok' : 'failed', selector: p.selector, label: p.label || p.name || p.id || '', value: p.value || '', before, after, error, needsReview: !ok, key: proposalKey(p) });
      continue;
    }
    const current = await loc.inputValue().catch(() => '');
    if (current && !p.forceFill && !isPlaceholderValue(current)) {
      fillOutcome(context, { phase: 'fill', action: p.action, status: 'skipped-existing-value', selector: p.selector, label: p.label || p.name || p.id || '', value: p.value || '', current, before, needsReview: false, key: proposalKey(p) });
      continue;
    }
    let ok = false;
    let method = 'fill';
    let error = '';
    if (p.kind === 'select') {
      method = 'select-native';
      try { ok = await selectNativeOption(loc, p); } catch (err) { error = err.message; }
    } else if (p.kind === 'custom-select') {
      method = 'custom-select';
      try { ok = await fillCustomSelectWithFallbacks(frame, loc, p); } catch (err) { error = err.message; }
    } else {
      if (p.forceFill) {
        method = 'forced-autocomplete';
        ok = await fillCustomSelectWithFallbacks(frame, loc, p).catch((err) => { error = err.message; return false; });
      }
      if (!ok) {
        method = p.forceFill ? 'forced-fill' : 'fill';
        await loc.fill(String(p.value)).then(() => { ok = true; }).catch((err) => { error = err.message; });
        if (p.forceFill || p.role === 'combobox') {
          await loc.press('ArrowDown').catch(() => {});
          await loc.press('Enter').catch(() => {});
        }
      }
    }
    // Read-back verification for plain text inputs: a successful loc.fill() can
    // still leave a controlled (React/Greenhouse) form empty after a re-render.
    // Re-type with real keystrokes if the value didn't stick.
    let textVerification = null;
    const isPlainText = !p.forceFill && p.role !== 'combobox' && p.kind !== 'select' && p.kind !== 'custom-select';
    if (ok && isPlainText) {
      textVerification = await verifyTextValue(loc, p.value);
      if (!textVerification.ok) {
        method = 'press-sequentially';
        await loc.click({ timeout: 1500 }).catch(() => {});
        await loc.fill('').catch(() => {});
        await loc.pressSequentially(String(p.value), { delay: 25 }).catch((err) => { error = err.message; });
        await loc.evaluate((el) => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }).catch(() => {});
        textVerification = await verifyTextValue(loc, p.value);
        ok = textVerification.ok;
        if (!ok && !error) error = `value did not persist (read back '${textVerification.actual}')`;
      }
    }
    let visibleVerification = null;
    if (ok && (p.forceFill || p.kind === 'custom-select' || p.role === 'combobox')) {
      visibleVerification = await visibleSelectVerification(loc, p.value);
      if (!visibleVerification.ok) {
        ok = await fillCustomSelectWithFallbacks(frame, loc, p).catch(() => false);
        if (ok) visibleVerification = await visibleSelectVerification(loc, p.value);
      }
      if (!visibleVerification.ok) {
        debugPrint(context.opts, `visible verification failed for ${p.label || p.selector}: expected '${p.value}', visible '${visibleVerification.visibleText || ''}', value '${visibleVerification.value || ''}'`);
      }
    }
    if (ok) changed = true;
    const after = context?.opts?.debug ? await fieldState(loc) : null;
    const needsReview = !ok || (visibleVerification && !visibleVerification.ok) || (textVerification && !textVerification.ok);
    fillOutcome(context, { phase: 'fill', action: p.action, method, status: ok ? (needsReview ? 'needs-review' : 'ok') : 'failed', selector: p.selector, label: p.label || p.name || p.id || '', kind: p.kind, type: p.type, role: p.role, value: p.value || '', alternatives: p.alternatives || [], forceFill: !!p.forceFill, before, after, visibleVerification, textVerification, error, needsReview, key: proposalKey(p) });
  }
  return changed;
}

function applyFillOutcomes(proposals, fillOutcomes = []) {
  const byKey = new Map();
  for (const event of fillOutcomes) {
    if (event?.key) byKey.set(event.key, event);
  }
  return proposals.map((proposal) => {
    const event = byKey.get(proposalKey(proposal));
    if (!event) return proposal;
    return {
      ...proposal,
      fillStatus: event.status,
      needsReview: !!event.needsReview,
      visibleVerification: event.visibleVerification || null,
      fillError: event.error || '',
    };
  });
}

async function clickSafeNext(page, proposals) {
  const frames = page.frames();
  const candidate = proposals.find(p => p.action === 'next' && p.safeNext && !p.finalSubmit && p.selector);
  if (!candidate) return false;
  const frame = Number.isInteger(candidate.frameIndex) ? frames[candidate.frameIndex] : page.mainFrame();
  if (!frame) return false;
  const loc = frame.locator(candidate.selector).first();
  if (await loc.count() === 0) return false;
  await loc.click({ timeout: 3000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  return true;
}

async function clickReveal(page, proposals) {
  const frames = page.frames();
  const candidate = proposals.find(p => p.action === 'reveal' && p.reveal && !p.finalSubmit && p.selector);
  if (!candidate) return false;
  const frame = Number.isInteger(candidate.frameIndex) ? frames[candidate.frameIndex] : page.mainFrame();
  if (!frame) return false;
  const loc = frame.locator(candidate.selector).first();
  if (await loc.count() === 0) return false;
  await loc.click({ timeout: 3000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return true;
}

function proposalKey(p) {
  return [p.frameIndex ?? '', p.selector || '', p.kind || '', p.type || '', p.label || '', p.optionLabel || '', p.action || ''].join('|');
}

async function fillApplicationFlow(page, context) {
  const allFields = [];
  const allProposals = [];
  const seen = new Set();
  for (let step = 0; step < MAX_FORM_STEPS; step++) {
    const fields = await detectFieldsFromPage(page);
    debugEvent(context, { phase: 'detect', step: step + 1, fieldCount: fields.length, fields });
    let proposals = proposeAnswers(fields, context);
    proposals = await draftFreeTextAnswers(proposals, context);
    debugEvent(context, { phase: 'propose', step: step + 1, proposalCount: proposals.length, proposals });
    allFields.push(...fields);
    for (const proposal of proposals) {
      const key = proposalKey(proposal);
      if (!seen.has(key)) {
        seen.add(key);
        allProposals.push({ ...proposal, step: step + 1 });
      }
    }

    await fillPage(page, proposals, context);
    // A gated posting only shows an "Apply" button on the first view. Click it
    // once to reveal the real form, then re-detect on the next iteration before
    // deciding anything about final submit / navigation.
    const revealed = await clickReveal(page, proposals);
    if (revealed) continue;
    const hasFinalSubmit = proposals.some(p => p.action === 'stop');
    if (hasFinalSubmit) break;
    const advanced = await clickSafeNext(page, proposals);
    if (!advanced) break;
  }
  return { fields: allFields, proposals: applyFillOutcomes(allProposals, context.fillOutcomes || []) };
}

function waitForUserExit(browser) {
  return new Promise((resolveP) => {
    const done = async () => {
      try { await browser.close(); } catch {}
      resolveP(0);
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

// Ask, on the terminal, whether the user actually submitted the application.
// Returns true only on an explicit yes. Falls back to false when there is no
// interactive TTY (e.g. piped/CI runs) so automated callers never block.
function promptSubmitted() {
  return new Promise((resolveP) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) { resolveP(false); return; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\nDid you submit this application? [y/N] ', (answer) => {
      rl.close();
      resolveP(/^\s*y(es)?\s*$/i.test(answer || ''));
    });
  });
}

// Launch a browser that anti-bot services (Cloudflare, PerimeterX, …) are far
// less likely to flag. Three things matter:
//   1. Use the real installed Chrome (`channel: 'chrome'`) instead of
//      Playwright's bundled Chromium, which has a HeadlessChrome-like
//      fingerprint even when run headed.
//   2. Use a persistent profile so a security challenge solved once leaves its
//      clearance cookie behind — subsequent runs on the same site skip it.
//   3. Strip the obvious automation tells (`navigator.webdriver`, the
//      `--enable-automation` switch, the "controlled by automated software"
//      infobar).
// Returns a { browser, page } pair; `browser` is a persistent BrowserContext,
// which exposes the same `.close()` used by waitForUserExit.
async function launchHardenedBrowser() {
  const profileDir = join(ROOT, 'output', '.browser-profile');
  mkdirSync(profileDir, { recursive: true });
  const launchOpts = {
    headless: false,
    viewport: null,
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  let context;
  let usedChannel = 'chromium';
  try {
    context = await chromium.launchPersistentContext(profileDir, { ...launchOpts, channel: 'chrome' });
    usedChannel = 'chrome';
  } catch {
    // Real Chrome not installed — fall back to bundled Chromium (more likely
    // to be challenged, but still works for sites without bot protection).
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
  }
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = context.pages()[0] || await context.newPage();
  return { browser: context, page, usedChannel };
}

// Heuristic detection of an interstitial bot/security challenge (Cloudflare
// "Checking your browser" / "Verificación de seguridad", hCaptcha, reCAPTCHA).
// We look at the visible text and known challenge widgets/iframes.
const CHALLENGE_TEXT_RE = /\b(verificaci[oó]n de seguridad|checking your browser|verifying you are human|verify you are (a )?human|just a moment|please (wait|stand by) while|attention required|security check|are you a robot|complete the security check)\b/i;
async function looksLikeBotChallenge(page) {
  try {
    const hit = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, 'i');
      const text = (document.body?.innerText || '').slice(0, 4000);
      if (re.test(text)) return true;
      const widget = document.querySelector(
        '#challenge-form, #cf-challenge-running, .cf-turnstile, [class*="turnstile" i], iframe[src*="challenges.cloudflare.com" i], iframe[src*="hcaptcha.com" i], iframe[src*="recaptcha" i], iframe[title*="challenge" i]'
      );
      return !!widget;
    }, CHALLENGE_TEXT_RE.source);
    return !!hit;
  } catch {
    return false;
  }
}

async function waitForChallengeToClear(page, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (!(await looksLikeBotChallenge(page))) return true;
  }
  return !(await looksLikeBotChallenge(page));
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`application-browser-assistant: ${e.message}`); return 2; }
  if (opts.help) { printHelp(); return 0; }

  const { reportFile, reportContent, meta } = findReport(opts);
  meta.reportFile = reportFile;
  const profile = await loadYaml(PATHS.profile);
  const cv = existsSync(PATHS.cv) ? readFileSync(PATHS.cv, 'utf-8') : '';
  const profileMode = existsSync(PATHS.profileMode) ? readFileSync(PATHS.profileMode, 'utf-8') : '';
  const targetUrl = opts.url || meta.url;
  const debugEvents = [];
  const context = { profile, report: meta, reportContent, cv, profileMode, opts, debugEvents, uploadPaths: { resume: opts.resume, coverLetter: opts.coverLetter } };

  let fields;
  let proposals;
  let browser = null;
  let page = null;

  if (opts.dryRun) {
    const html = await htmlForDryRun({ ...opts, url: targetUrl });
    fields = detectFieldsFromHtml(html);
    debugEvent(context, { phase: 'detect', step: 1, fieldCount: fields.length, fields });
    proposals = proposeAnswers(fields, context);
    proposals = await draftFreeTextAnswers(proposals, context);
    debugEvent(context, { phase: 'propose', step: 1, proposalCount: proposals.length, proposals });
  } else {
    if (!targetUrl && !opts.fixture) throw new Error('browser mode needs a URL or --fixture');
    let usedChannel;
    ({ browser, page, usedChannel } = await launchHardenedBrowser());
    if (usedChannel !== 'chrome') {
      console.log('Note: real Chrome not found — using bundled Chromium, which some sites flag as a bot.');
      console.log('      Install Google Chrome (or run `npx playwright install chrome`) for best results.');
    }
    const url = opts.fixture ? pathToFileURL(resolve(opts.fixture)).href : targetUrl;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    if (await looksLikeBotChallenge(page)) {
      console.log('\n⚠ Security / bot check detected on this page.');
      console.log('  Solve it manually in the browser window (checkbox / puzzle).');
      console.log('  Your session is saved to output/.browser-profile, so you usually');
      console.log('  will not be challenged again on this site.');
      console.log('  Waiting up to 120s for the challenge to clear…');
      const cleared = await waitForChallengeToClear(page, 120000);
      console.log(cleared ? '  ✓ Challenge cleared — continuing.' : '  ⏱ Still challenged after 120s — continuing anyway; fill may be partial.');
    }
    ({ fields, proposals } = await fillApplicationFlow(page, context));
  }

  const audit = writeAudit(meta, proposals, opts);
  const debugAudit = opts.debug ? writeDebugAudit(meta, fields, proposals, debugEvents, opts) : null;
  const filledCount = proposals.filter(p => ['fill', 'upload', 'check'].includes(p.action) && p.fillStatus && !p.needsReview && !/^failed|missing-selector$/i.test(p.fillStatus)).length;
  const reviewCount = proposals.filter(p => p.needsReview).length;
  const skippedCount = proposals.filter(p => p.action === 'skip').length;

  console.log(`Detected ${fields.length} field/control(s).`);
  for (const p of proposals) {
    const icon = p.needsReview ? '⚠' : ['fill', 'upload', 'check'].includes(p.action) ? '✓' : p.action === 'next' ? '→' : p.action === 'stop' ? '■' : '•';
    const status = p.needsReview ? 'needs review' : p.fillStatus && p.fillStatus !== 'ok' ? p.fillStatus : '';
    const suffix = [status, p.reason || ''].filter(Boolean).join(' — ');
    console.log(`${icon} ${p.action.padEnd(5)} ${p.label || p.name || p.id} — ${suffix}`);
  }
  console.log(`\nFill summary: filled ${filledCount}, needs manual check ${reviewCount}, skipped ${skippedCount}.`);
  console.log(`\nAudit written: ${audit}`);
  if (debugAudit) {
    console.log(`Debug audit written: ${debugAudit}`);
    for (const event of debugEvents.filter(e => e.phase === 'fill')) {
      const label = event.label || event.selector || 'field';
      console.log(`DEBUG fill ${event.status} ${event.method || event.action || ''} ${label} -> ${event.value || ''}`.trim());
      if (event.before || event.after || event.error) {
        console.log(`DEBUG detail ${JSON.stringify({ before: event.before, after: event.after, error: event.error }).slice(0, 1200)}`);
      }
    }
  }
  console.log('\nReview the application in the browser. I will not submit it for you. Click submit manually if everything is correct.');
  if (!opts.dryRun && browser) {
    console.log('Leave this process running while you review; press Ctrl+C when done.');
    await waitForUserExit(browser);
    // After the window closes, optionally ask whether the user submitted so the
    // caller (review.mjs) can flip the queue + tracker to Applied. Exit code 10
    // = confirmed submitted; anything else = not submitted / unknown.
    if (opts.confirmSubmit) {
      const submitted = await promptSubmitted();
      return submitted ? 10 : 0;
    }
    return 0;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(code => process.exit(code ?? 0)).catch(err => {
    console.error(`application-browser-assistant failed: ${err.message}`);
    process.exit(1);
  });
}
