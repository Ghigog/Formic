/**
 * The AI providers an agent can run on.
 *
 * Two kinds. API providers are called by Formic directly: Anthropic has its
 * own format, and everyone else here speaks OpenAI's chat completions format
 * at their own address, which is why adding one is an entry in this list.
 *
 * CLI agents are the coding tools people already pay for (Claude Code, Codex,
 * Gemini CLI). Formic does not call those; it runs them in the repository's
 * own GitHub Actions on the person's plan, and takes their work from there.
 * They can run any column: the coding ones change the repository, the rest
 * read it and answer.
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
  "clinepass",
  "claude-code",
  "codex",
  "gemini-cli",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Which connector talks to it; "cli" runs in GitHub Actions instead. */
  kind: "anthropic" | "openai" | "cli";
  /** For CLI agents: which tool the runner workflow starts. */
  cli?: "claude" | "codex" | "gemini";
  /** For CLI agents: the repository secret the credential is stored as. */
  secretName?: string;
  /** For CLI agents: how to get the credential, step by step. */
  howToGetKey?: string;
  /** What the credential is called, e.g. "API key" or "Claude Code token". */
  keyName: string;
  /** OpenAI-format endpoint root, without a trailing slash. */
  baseUrl?: string;
  /** Where to get a key. */
  keyUrl: string;
  keyPlaceholder: string;
  /** One line for Settings. */
  note: string;
  /** Has a free tier, rate-limited. Terms change; the note says so. */
  freeTier: boolean;
  /**
   * Runs on the person's own plan rather than on a key Formic meters: a
   * subscription, a free tier, or a CLI tool billed to their own account.
   * No per-token price is knowable from here, and Formic does not guess one,
   * so the spend ceiling does not apply to these runs. Time and attempt
   * limits still do.
   */
  flatRate?: boolean;
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
    keyName: "API key",
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
    keyName: "API key",
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
    keyName: "API key",
    envKey: "GEMINI_API_KEY",
    suggestedModels: [],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    // The host DeepSeek's docs publish. Paths under /v1 also answer 401 when
    // unauthenticated, but so does the host without it, so that 401 never
    // showed /v1 was the documented route.
    baseUrl: "https://api.deepseek.com",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyPlaceholder: "sk-…",
    note: "Low-cost models with a thinking mode, 1M-token context and JSON output.",
    freeTier: false,
    keyName: "API key",
    envKey: "DEEPSEEK_API_KEY",
    suggestedModels: ["deepseek-flash", "deepseek-v4-pro"],
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
    keyName: "API key",
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
    keyName: "API key",
    envKey: "GROQ_API_KEY",
    suggestedModels: [],
  },
  {
    id: "clinepass",
    label: "ClinePass",
    kind: "openai",
    baseUrl: "https://api.cline.bot/api/v1",
    keyUrl: "https://app.cline.bot",
    // Cline does not publish a prefix for these, so do not suggest one.
    keyPlaceholder: "…",
    note: "$9.99/mo flat rate for a curated set of open-weight models (DeepSeek, GLM, Kimi, Qwen and others). One key for all of them. Create a durable key at app.cline.bot under Settings > API Keys. A token copied from the Cline extension or CLI is an account auth token that expires in 60 minutes: /models still answers 200 with it, but chat calls start returning 401 an hour later.",
    freeTier: false,
    flatRate: true,
    keyName: "API key",
    envKey: "CLINE_API_KEY",
    suggestedModels: [
      "cline-pass/deepseek-v4.1-flash",
      "cline-pass/glm-5.3",
      "cline-pass/kimi-k3",
      "cline-pass/qwen3.7-max",
    ],
  },
  {
    id: "claude-code",
    label: "Claude Code (your Claude plan)",
    kind: "cli",
    cli: "claude",
    secretName: "FORMIC_CLAUDE_CODE_TOKEN",
    keyName: "Claude Code token",
    keyUrl:
      "https://code.claude.com/docs/en/authentication#generate-a-long-lived-token",
    keyPlaceholder: "sk-ant-oat01-…",
    note: "Runs Claude Code in your repo's GitHub Actions, on your Pro or Max plan. No API bill.",
    howToGetKey:
      "On your computer, run `claude setup-token`, approve in the browser, and paste the token it prints. It lasts a year.",
    freeTier: false,
    flatRate: true,
    envKey: "CLAUDE_CODE_OAUTH_TOKEN",
    suggestedModels: ["sonnet", "opus"],
  },
  {
    id: "codex",
    label: "Codex (your ChatGPT plan)",
    kind: "cli",
    cli: "codex",
    secretName: "FORMIC_CODEX_AUTH",
    keyName: "Codex sign-in",
    keyUrl: "https://github.com/openai/codex",
    keyPlaceholder: '{"tokens": …} or sk-…',
    note: "Runs OpenAI's Codex in your repo's GitHub Actions, on your ChatGPT plan or an OpenAI key.",
    howToGetKey:
      "On your computer, run `codex login` and sign in with ChatGPT, then paste the contents of ~/.codex/auth.json. Or paste an OpenAI API key. A ChatGPT sign-in can expire; paste it again if runs start failing to sign in.",
    freeTier: false,
    flatRate: true,
    envKey: "CODEX_API_KEY",
    suggestedModels: [],
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI (free tier)",
    kind: "cli",
    cli: "gemini",
    secretName: "FORMIC_GEMINI_API_KEY",
    keyName: "Gemini API key",
    keyUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza…",
    note: "Runs Google's Gemini CLI in your repo's GitHub Actions. A free Gemini API key works, within its daily limits.",
    howToGetKey: "Create a key at aistudio.google.com/apikey and paste it.",
    freeTier: true,
    flatRate: true,
    envKey: "GEMINI_API_KEY",
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
