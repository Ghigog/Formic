/** Minimal class joiner. No dependency needed for what this codebase does. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
