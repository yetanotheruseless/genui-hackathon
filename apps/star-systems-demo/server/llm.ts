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
  anthropic: "claude-opus-4-7",
  openai: "gpt-5.5-mini",
  gemini: "gemini-2.5-flash",
  google: "gemini-2.5-flash",
};

/**
 * Models that reject the Anthropic API's `temperature` parameter — Opus
 * 4.7 returns "temperature is deprecated for this model". The Vercel
 * `ai` package v4 defaults temperature to 0 (see the package's "TODO v5
 * remove default 0 for temperature"), so without intervention every
 * call hits this. We wrap the model and scrub temperature before
 * doGenerate / doStream forwards it.
 */
function isTemperatureSensitive(name: string): boolean {
  return name.startsWith("claude-opus-4-7") || name.startsWith("claude-sonnet-4-7");
}

function withoutTemperature(model: LanguageModelV1): LanguageModelV1 {
  const wrap = <T extends { temperature?: number | undefined }>(opts: T): T =>
    ({ ...opts, temperature: undefined });
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop === "doGenerate" || prop === "doStream") {
        const fn = (target as unknown as Record<string, (o: unknown) => unknown>)[prop as string];
        return (opts: { temperature?: number }) => fn.call(target, wrap(opts));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

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
    case "anthropic": {
      const m = anthropic(name);
      return isTemperatureSensitive(name) ? withoutTemperature(m) : m;
    }
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
