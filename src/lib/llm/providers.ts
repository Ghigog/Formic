/**
 * The AI providers an agent can run on.
 *
 * Two wire formats cover them all. Anthropic has its own; everyone else here
 * speaks OpenAI's chat completions format at their own address, which is
 * why adding a provider is one entry in this list rather than a connector.
 *
 * No server imports: Settings and the agent editor list the same providers.
 */

export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "gemini",
  "deepseek",
  "openrouter",
  "groq",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Which connector talks to it. */
  kind: "anthropic" | "openai";
  /** OpenAI-format endpoint root, without a trailing slash. */
  baseUrl?: string;
  /** Where to get a key. */
  keyUrl: string;
  keyPlaceholder: string;
  /** One line for Settings. */
  note: string;
  /** Has a free tier, rate-limited. Terms change; the note says so. */
  freeTier: boolean;
  /** Local mode only: a key from the environment, for development. */
  envKey: string;
  /** Suggestions shown until the live model list loads. */
  suggestedModels: string[];
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
    note: "Claude models. Strong at code.",
    freeTier: false,
    envKey: "ANTHROPIC_API_KEY",
    suggestedModels: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
    note: "GPT models.",
    freeTier: false,
    envKey: "OPENAI_API_KEY",
    suggestedModels: [],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza…",
    note: "Free tier with daily limits. Google may use free-tier prompts to improve its products.",
    freeTier: true,
    envKey: "GEMINI_API_KEY",
    suggestedModels: [],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyPlaceholder: "sk-…",
    note: "Low-cost models.",
    freeTier: false,
    envKey: "DEEPSEEK_API_KEY",
    suggestedModels: [],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-…",
    note: "One key for hundreds of models, some free and rate-limited.",
    freeTier: true,
    envKey: "OPENROUTER_API_KEY",
    suggestedModels: [],
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    keyPlaceholder: "gsk_…",
    note: "Fast open models. Free tier with rate limits.",
    freeTier: true,
    envKey: "GROQ_API_KEY",
    suggestedModels: [],
  },
];

export function provider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isProviderId(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

/** "claude-sonnet-5" and "gemini-2.5-flash" as they appear on a card. */
export function shortModelName(model: string): string {
  return model.replace(/^models\//, "").replace(/^[\w-]+\//, "");
}
