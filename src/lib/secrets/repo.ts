/**
 * Turns whatever was pasted into GITHUB_REPO into `owner/repo`, or null.
 *
 * Accepts the forms people actually paste: `owner/repo`, the repository URL
 * (with or without `.git` or a trailing slash), the SSH remote, and any of
 * those wrapped in quotes copied from .env.example.
 *
 * Deliberately free of `server-only` so the seed CLI can use it too.
 */
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

export function normalizeRepo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  value = (value.match(/^(['"])([\s\S]*)\1$/)?.[2] ?? value).trim();
  value = value
    .replace(/^git@github\.com:/i, "")
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return OWNER_REPO.test(value) ? value : null;
}
