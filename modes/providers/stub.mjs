/**
 * modes/providers/stub.mjs — Deterministic stub provider for tests
 *
 * Returns a canned response that includes a valid ---SCORE_SUMMARY--- block,
 * so the runner can be exercised end-to-end without any network access or
 * API keys. Used by test-all.mjs and by `career-ops` when STUB_LLM=1 is set.
 *
 * No external calls. No env requirements.
 */

export const NAME = 'stub';
export const DEFAULT_MODEL = 'stub-1';

export function isConfigured() {
  return true;
}

export async function complete({ system = '', user = '', model = DEFAULT_MODEL } = {}) {
  // Echo a short deterministic envelope so callers can verify wiring.
  const sysLen = system.length;
  const usrLen = user.length;
  const text = [
    `# Stub evaluation (provider=stub model=${model})`,
    '',
    `System prompt: ${sysLen} chars.`,
    `User prompt: ${usrLen} chars.`,
    '',
    '## A) Role Summary',
    '| Field | Value |',
    '|-------|-------|',
    '| Archetype | Stub Archetype |',
    '| TL;DR | Deterministic stub output for tests. |',
    '',
    '---SCORE_SUMMARY---',
    'COMPANY: StubCo',
    'ROLE: Stub Engineer',
    'SCORE: 4.0',
    'ARCHETYPE: Stub Archetype',
    'LEGITIMACY: High Confidence',
    '---END_SUMMARY---',
    '',
  ].join('\n');

  return {
    text,
    usage: { input_tokens: sysLen + usrLen, output_tokens: text.length, total_tokens: sysLen + usrLen + text.length },
  };
}
