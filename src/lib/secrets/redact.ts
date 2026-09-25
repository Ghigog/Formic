/**
 * Secret scrubbing for anything that reaches a log, an event stream or the UI.
 *
 * Two layers, because either alone is insufficient:
 *
 *   - Known values. The credentials this process actually holds are replaced
 *     wherever they appear, even split across a line.
 *   - Known shapes. Tokens the process does not hold (a key pasted into a
 *     ticket description, a token echoed by a tool) still match a pattern.
 *
 * This is not in the domain layer on purpose: it needs process.env, so it is
 * server-only and applied at the boundary, not sprinkled through call sites.
 */

const REDACTED = "[redacted]";

/** Token shapes worth catching even when the value is not one of ours. */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "github-pat", re: /gh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: "github-fine-grained", re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "openai", re: /sk-[A-Za-z0-9]{32,}/g },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "bearer", re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { name: "basic-auth-url", re: /\/\/[^/\s:@]+:[^/\s:@]+@/g },
  { name: "private-key", re: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g },
];

/** Environment variables whose values are scrubbed wherever they appear. */
const SECRET_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "E2B_API_KEY",
  "DATABASE_URL",
] as const;

/** Values short enough to appear by accident are not worth substring-matching. */
const MIN_SECRET_LENGTH = 8;

/** Only the string values are read, so a plain record is enough. */
export type EnvLike = Readonly<Record<string, string | undefined>>;

export function knownSecretValues(env: EnvLike = process.env): string[] {
  const values: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    values.push(value);

    // A connection string leaks through its password even when the whole
    // string never appears verbatim.
    const password = value.match(/\/\/[^/\s:@]+:([^/\s:@]+)@/)?.[1];
    if (password && password.length >= MIN_SECRET_LENGTH) values.push(password);
  }
  return values;
}

export function redact(
  input: string,
  extraValues: readonly string[] = [],
  env: EnvLike = process.env,
): string {
  if (!input) return input;

  let out = input;

  for (const value of [...knownSecretValues(env), ...extraValues]) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    out = out.replaceAll(value, REDACTED);
  }

  for (const { re } of PATTERNS) {
    out = out.replace(re, (match) =>
      // Keep the URL shape so a redacted clone URL is still readable.
      match.startsWith("//") ? "//[redacted]@" : REDACTED,
    );
  }

  return out;
}

/** Deep-redacts an object destined for a log or an event payload. */
export function redactDeep<T>(value: T, extraValues: readonly string[] = []): T {
  if (typeof value === "string") {
    return redact(value, extraValues) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, extraValues)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v, extraValues);
    }
    return out as T;
  }
  return value;
}

export function containsSecret(input: string, env: EnvLike = process.env): boolean {
  return redact(input, [], env) !== input;
}
