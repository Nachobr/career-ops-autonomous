/**
 * modes/providers/index.mjs — Provider registry
 *
 * Each provider module exports:
 *   NAME: string
 *   DEFAULT_MODEL: string
 *   isConfigured(): boolean   — whether the env is set up to use this provider
 *   complete({ system, user, model, maxTokens, temperature })
 *     -> Promise<{ text: string, usage: object | null }>
 */

import * as gemini from './gemini.mjs';
import * as anthropic from './anthropic.mjs';
import * as openai from './openai.mjs';
import * as ollama from './ollama.mjs';
import * as stub from './stub.mjs';

export const PROVIDERS = {
  gemini,
  anthropic,
  openai,
  ollama,
  stub,
};

export function listProviders() {
  return Object.keys(PROVIDERS);
}

export function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) {
    throw new Error(
      `Unknown LLM provider "${name}". Available: ${listProviders().join(', ')}`
    );
  }
  return p;
}
