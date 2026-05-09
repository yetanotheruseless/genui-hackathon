/**
 * Provider-agnostic LLM client for the Culture / star-systems server.
 *
 * Mirrors the Python `agent_core/loop.py` env contract:
 *   LLM_PROVIDER  ∈ {anthropic, openai, gemini, google}   (default: anthropic)
 *   LLM_MODEL     a model name for the chosen provider     (default: provider-appropriate)
 *
 * Uses Vercel's `ai` SDK with `generateObject` for typed JSON output —
 * the SDK enforces our Zod schemas, so we don't have to strip markdown
 * fences or hand-parse responses.
 *
 * **Fail-fast policy**: if there's no API key, or the provider call
 * fails, or the response doesn't match the schema, this throws. There is
 * NO fallback path. Silent canned content is worse than a loud error
 * during development.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { generateObject, type LanguageModelV1 } from "ai";
import { z } from "zod";

const DEFAULTS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5.5-mini",
  gemini: "gemini-2.5-flash",
  google: "gemini-2.5-flash",
};

export function getProvider(): string {
  return (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();
}

export function getModelName(): string {
  const provider = getProvider();
  return process.env.LLM_MODEL ?? DEFAULTS[provider] ?? DEFAULTS.anthropic;
}

export function getModel(): LanguageModelV1 {
  const provider = getProvider();
  const name = getModelName();
  switch (provider) {
    case "anthropic":
      return anthropic(name);
    case "openai":
      return openai(name);
    case "gemini":
    case "google":
      return google(name);
    default:
      throw new Error(
        `Unknown LLM_PROVIDER: ${provider}. Try anthropic | openai | gemini.`,
      );
  }
}

/** True if the configured provider has its API key in env. Used only for HUD status display. */
export function hasCredentials(): boolean {
  switch (getProvider()) {
    case "anthropic":
      return !!process.env.ANTHROPIC_API_KEY;
    case "openai":
      return !!process.env.OPENAI_API_KEY;
    case "gemini":
    case "google":
      return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY);
    default:
      return false;
  }
}

function assertCredentials(): void {
  if (hasCredentials()) return;
  const provider = getProvider();
  const expected =
    provider === "anthropic" ? "ANTHROPIC_API_KEY" :
    provider === "openai"    ? "OPENAI_API_KEY" :
                               "GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY)";
  throw new Error(
    `[llm] No credentials for LLM_PROVIDER=${provider}. Set ${expected} in env or change LLM_PROVIDER.`,
  );
}

/**
 * Generate a typed object. Throws if credentials are missing, the
 * provider call fails, or the response doesn't fit the schema.
 */
export async function generateTyped<T>(
  schema: z.ZodSchema<T>,
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  assertCredentials();
  const { object } = await generateObject({
    model: getModel(),
    schema,
    system: systemPrompt,
    prompt: userPrompt,
    maxRetries: 1,
  });
  return object;
}
