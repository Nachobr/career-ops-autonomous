/**
 * semantic-rank.mjs — Zero-dependency lexical fit ranking for scanned job titles.
 *
 * Ranks each scanned job title by how well its words overlap your profile's
 * target_roles, with light domain-synonym expansion and weighting so generic
 * words ("engineer", "developer") don't inflate off-target titles. No model,
 * no download, no network, no LLM tokens — pure string math, runs instantly.
 *
 * Used as an optional ranking step between the keyword title_filter and the
 * expensive LLM eval to cut how many off-target postings reach the evaluator.
 *
 * Graceful by design: if there are no target_roles, ranking is a no-op and the
 * caller keeps all offers — the scan never breaks because of this filter.
 */

import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';

// Connector / seniority / boilerplate words that carry no fit signal.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'at', 'by', 'with',
  'senior', 'junior', 'jr', 'sr', 'lead', 'staff', 'principal', 'mid', 'entry', 'level',
  'i', 'ii', 'iii', 'iv', 'remote', 'hybrid', 'onsite', 'on-site', 'intern', 'internship',
  'm', 'w', 'd', 'f', 'x', 'deutschland', 'germany', 'uk', 'us', 'eu',
]);

// Generic role nouns: real signal, but weak — many unrelated titles contain
// them, so they get a low weight when scoring.
const GENERIC = new Set([
  'engineer', 'developer', 'dev', 'software', 'programmer', 'architect',
  'manager', 'specialist', 'consultant', 'analyst', 'designer',
]);
const GENERIC_WEIGHT = 0.3;

// Domain synonym clusters. If any of your role words falls in a cluster, the
// whole cluster joins the relevance vocabulary so semantically-related titles
// (e.g. "Machine Learning" for an "AI" role) still match lexically.
const CLUSTERS = [
  ['ai', 'ml', 'llm', 'llms', 'nlp', 'genai', 'generative', 'artificial', 'intelligence',
   'machine', 'learning', 'deep', 'agentic', 'rag', 'mlops', 'llmops'],
  ['web3', 'blockchain', 'crypto', 'cryptocurrency', 'defi', 'solidity', 'smart',
   'contracts', 'contract', 'ethereum', 'evm', 'dapp', 'dapps', 'onchain', 'nft'],
  ['fullstack', 'full', 'stack', 'frontend', 'backend', 'developer', 'engineer', 'software'],
];

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t));
}

/**
 * Extract role title strings from config/profile.yml `target_roles`.
 * Handles a flat list, or a dict with `primary` (list of strings) and
 * `archetypes` (list of {name} dicts). "Product Manager/owner" → "Product Manager".
 */
export function loadTargetRoles(profilePath = 'config/profile.yml') {
  if (!existsSync(profilePath)) return [];
  let data;
  try {
    data = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch {
    return [];
  }
  const raw = data.target_roles;
  const roles = [];

  if (Array.isArray(raw)) {
    for (const r of raw) {
      const s = String(r ?? '').trim();
      if (s) roles.push(s);
    }
  } else if (raw && typeof raw === 'object') {
    const primary = Array.isArray(raw.primary) ? raw.primary : [];
    for (const r of primary) {
      const s = String(r ?? '').trim();
      if (s) roles.push(s);
    }
    const archetypes = Array.isArray(raw.archetypes) ? raw.archetypes : [];
    for (const arch of archetypes) {
      if (arch && typeof arch === 'object' && arch.name) {
        const name = String(arch.name).split('/')[0].trim();
        if (name) roles.push(name);
      } else if (typeof arch === 'string') {
        const s = arch.trim();
        if (s) roles.push(s);
      }
    }
  }
  return [...new Set(roles)];
}

/**
 * Build the relevance vocabulary from role titles: every meaningful role word
 * plus the full synonym cluster of any word that belongs to one.
 */
export function buildVocab(roles) {
  const vocab = new Set();
  for (const role of roles) {
    for (const tok of tokenize(role)) {
      vocab.add(tok);
      for (const cluster of CLUSTERS) {
        if (cluster.includes(tok)) for (const c of cluster) vocab.add(c);
      }
    }
  }
  return vocab;
}

/**
 * Lexical fit score in [0,1]: the weighted fraction of a title's meaningful
 * words that are relevant to your roles. Generic role nouns count weakly so a
 * lone "engineer"/"developer" doesn't carry an otherwise off-target title.
 */
export function scoreTitle(title, vocab) {
  const tokens = tokenize(title);
  if (tokens.length === 0) return 0;
  let matched = 0;
  let total = 0;
  for (const t of tokens) {
    const inVocab = vocab.has(t);
    const w = inVocab && GENERIC.has(t) ? GENERIC_WEIGHT : 1;
    total += w;
    if (inVocab) matched += w;
  }
  return total === 0 ? 0 : matched / total;
}

/**
 * Score and rank jobs by lexical title fit against the given roles.
 * @returns {Promise<Array<{job:object, score:number}>>} sorted DESC by score.
 * @throws if roles is empty.
 */
export async function rankJobsByTitle(jobs, roles) {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error('no target_roles to rank against');
  }
  if (!Array.isArray(jobs) || jobs.length === 0) return [];

  const vocab = buildVocab(roles);
  const scored = jobs.map(job => ({ job, score: scoreTitle(job.title, vocab) }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Convenience wrapper: rank, then keep the best matches by an optional
 * similarity floor and/or top-K cap. Returns the kept job objects (with a
 * `_fitScore` field) plus stats. Falls back to returning all jobs unchanged if
 * there are no roles to rank against.
 *
 * @param {Array} jobs
 * @param {{ profilePath?:string, floor?:number, topK?:number, roles?:string[] }} opts
 */
export async function applySemanticRank(jobs, opts = {}) {
  const roles = opts.roles || loadTargetRoles(opts.profilePath);
  const floor = typeof opts.floor === 'number' ? opts.floor : null;
  const topK = Number.isInteger(opts.topK) && opts.topK > 0 ? opts.topK : null;

  if (!roles.length) {
    return { ok: false, reason: 'no target_roles in profile', kept: jobs, ranked: [], roles };
  }

  let ranked;
  try {
    ranked = await rankJobsByTitle(jobs, roles);
  } catch (err) {
    return { ok: false, reason: err.message, kept: jobs, ranked: [], roles };
  }

  let kept = ranked;
  if (floor != null) kept = kept.filter(r => r.score >= floor);
  if (topK != null) kept = kept.slice(0, topK);

  const keptJobs = kept.map(r => ({ ...r.job, _fitScore: Number(r.score.toFixed(4)) }));
  return { ok: true, reason: null, kept: keptJobs, ranked, roles, floor, topK };
}
