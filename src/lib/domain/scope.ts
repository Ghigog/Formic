/**
 * File scopes are the mechanism behind the concurrency claim: two agents may
 * run at the same time only if the files they are allowed to touch are
 * disjoint.
 *
 * Scopes are *directory prefixes*, not globs. Glob intersection is
 * undecidable-adjacent in the general case and quietly wrong in the common
 * one; prefix comparison is exact and explainable to a user. If richer
 * patterns are needed later, they go through a normaliser that reduces them to
 * prefixes, not through a smarter intersection algorithm.
 */

/**
 * Files that many tickets will legitimately need to touch. A ticket declaring
 * one of these cannot run concurrently with another that does; it goes through
 * the serialized lane instead. See docs/tasks/PROT-04-architect-agent.md.
 */
export const SHARED_SURFACE = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "next.config.ts",
  "prisma/schema.prisma",
] as const;

export type FileScope = readonly string[];

export class ScopeError extends Error {}

/**
 * Normalise a declared path to a comparable form: no leading slash, no
 * trailing slash, no `.` or `..` segments, no duplicate separators.
 */
export function normalizeScopePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new ScopeError("Empty file scope entry.");

  const segments = trimmed.split("/").filter((s) => s !== "" && s !== ".");

  if (segments.some((s) => s === "..")) {
    throw new ScopeError(`File scope may not escape the repository: "${raw}"`);
  }
  if (segments.length === 0) {
    throw new ScopeError(
      `File scope "${raw}" resolves to the repository root, which is never a valid scope.`,
    );
  }
  // A trailing "*" or "**" is a common LLM output shape. Treat it as "this
  // directory and below", which is what a prefix already means.
  while (
    segments.length > 0 &&
    (segments[segments.length - 1] === "*" ||
      segments[segments.length - 1] === "**")
  ) {
    segments.pop();
  }
  if (segments.length === 0) {
    throw new ScopeError(
      `File scope "${raw}" matches the whole repository, which is never a valid scope.`,
    );
  }

  return segments.join("/");
}

export function normalizeScope(scope: readonly string[]): string[] {
  // De-duplicate *before* the containment pass. Two equal entries each contain
  // the other, so filtering first would drop both and leave the ticket with an
  // empty scope, which reads downstream as "may touch nothing" rather than the
  // intended directory.
  const unique = [...new Set(scope.map(normalizeScopePath))];

  // Drop entries already covered by a broader sibling, so ["src", "src/ui"]
  // becomes ["src"] and comparisons stay stable.
  return unique
    .filter((p) => !unique.some((q) => q !== p && containsPath(q, p)))
    .sort();
}

/** True when `parent` is the same path as `child` or a directory above it. */
export function containsPath(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent + "/");
}

/** Two scopes overlap when any entry of one contains, or is contained by, an entry of the other. */
export function scopesOverlap(a: FileScope, b: FileScope): boolean {
  return overlappingPaths(a, b).length > 0;
}

export function overlappingPaths(
  a: FileScope,
  b: FileScope,
): Array<[string, string]> {
  const hits: Array<[string, string]> = [];
  for (const x of a) {
    for (const y of b) {
      if (containsPath(x, y) || containsPath(y, x)) hits.push([x, y]);
    }
  }
  return hits;
}

export function touchesSharedSurface(scope: FileScope): string[] {
  return SHARED_SURFACE.filter((shared) =>
    scope.some((p) => containsPath(p, shared) || containsPath(shared, p)),
  );
}

/**
 * Whether a changed file is inside a ticket's declared scope. This is the
 * check the Coder Agent runs against its own diff before committing.
 */
export function pathInScope(changedPath: string, scope: FileScope): boolean {
  const normalized = normalizeScopePath(changedPath);
  return scope.some((s) => containsPath(s, normalized));
}

export function violationsInDiff(
  changedPaths: readonly string[],
  scope: FileScope,
): string[] {
  return changedPaths.filter((p) => !pathInScope(p, scope));
}
