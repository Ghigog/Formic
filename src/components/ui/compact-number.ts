/**
 * A count as a person reads it, for counters that run into the thousands:
 * "840", "12.4k", "1.20M". Shared by the ambient drawer's token counters and
 * the token count under a chat answer, so both say the same number the same
 * way.
 */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
