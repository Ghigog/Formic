import "server-only";

import { z } from "zod";

/**
 * Validated server-side configuration.
 *
 * Nothing here is ever imported from a client component: the `server-only`
 * guard turns that into a build error rather than a runtime leak. Values are
 * read lazily so a missing optional credential degrades the feature that needs
 * it instead of failing the whole process at import time.
 */

const schema = z.object({
  DATABASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/repo")
    .optional(),
  GITHUB_BASE_BRANCH: z.string().default("main"),
  /** Shared secret for the GitHub webhook receiver. See PROT-07. */
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  /**
   * Where the Reviewer Agent is allowed to merge. "integration" keeps the
   * base branch behind a human click; "base" is the PRD's original
   * behaviour and an explicit decision to turn it on.
   */
  MERGE_TARGET: z.enum(["integration", "base"]).default("integration"),
  E2B_API_KEY: z.string().optional(),
  SANDBOX_PROVIDER: z.enum(["e2b", "local"]).default("local"),
  AGENT_PROVIDER: z.enum(["anthropic", "mock"]).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Vercel's env var UI takes a value verbatim: pasting `SANDBOX_PROVIDER="local"`
 * straight from .env.example (quotes included, as the file's own syntax
 * shows them) sets the value to the five characters `"local"`, not `local`.
 * Stripping one matching pair of surrounding quotes tolerates that without
 * weakening validation of the actual value.
 */
function unquote(value: string): string {
  return value.match(/^(['"])([\s\S]*)\1$/)?.[2] ?? value;
}

function cleanedProcessEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    out[key] = typeof value === "string" ? unquote(value.trim()) : value;
  }
  return out;
}

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(cleanedProcessEnv());
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration. ${detail}`);
  }
  cached = parsed.data;
  return cached;
}

export class MissingCredentialError extends Error {
  constructor(
    readonly key: string,
    readonly feature: string,
  ) {
    super(
      `${feature} needs ${key}, which is not configured. See .env.example.`,
    );
    this.name = "MissingCredentialError";
  }
}

export function requireCredential(
  key:
    | "ANTHROPIC_API_KEY"
    | "GITHUB_TOKEN"
    | "E2B_API_KEY"
    | "GITHUB_REPO"
    | "GITHUB_WEBHOOK_SECRET",
  feature: string,
): string {
  const value = env()[key];
  if (!value) throw new MissingCredentialError(key, feature);
  return value;
}

/**
 * A clone URL carrying the GitHub credential. Built at the point of use and
 * never stored, so it cannot end up in a database column or an event payload.
 */
export function authenticatedCloneUrl(repoFullName: string): string {
  const token = requireCredential("GITHUB_TOKEN", "Cloning the target repository");
  return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
}

export function resetEnvCache(): void {
  cached = null;
}
