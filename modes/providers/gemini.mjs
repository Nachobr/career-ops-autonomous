/**
 * modes/providers/gemini.mjs — Google Gemini adapter
 *
 * Implements the provider contract defined in modes/providers/index.mjs:
 *   complete({ system, user, model, maxTokens, temperature }) -> { text, usage }
 *
 * Requires env GEMINI_API_KEY and the existing @google/generative-ai dep
 * (already used by gemini-eval.mjs).
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

export const NAME = 'gemini';
export const DEFAULT_MODEL = 'gemini-2.0-flash';

export function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export async function complete({ system, user, model, maxTokens = 4096, temperature = 0.3 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const err = new Error('GEMINI_API_KEY is not set');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const genAI = new GoogleGenerativeAI(key);
  const m = genAI.getGenerativeModel({
    model: model || DEFAULT_MODEL,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  });

  const result = await m.generateContent([
    { text: system },
    { text: user },
  ]);
  const text = result.response.text();
  const usage = result.response.usageMetadata
    ? {
        input_tokens: result.response.usageMetadata.promptTokenCount,
        output_tokens: result.response.usageMetadata.candidatesTokenCount,
        total_tokens: result.response.usageMetadata.totalTokenCount,
      }
    : null;

  return { text, usage };
}
