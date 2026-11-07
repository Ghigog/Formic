import "server-only";

import { VcsError } from "./types";

/**
 * The one way Formic talks to gitlab.com's REST API (v4), for the client and
 * the project picker alike. A project is addressed by its path, URL-encoded
 * (`group%2Fproject`), which GitLab accepts wherever it takes an id.
 */

export const GITLAB_API = "https://gitlab.com/api/v4";

/** Every page a listing may read: enough for the picker and recent pipelines. */
const MAX_PAGES = 5;

export function projectId(path: string): string {
  return encodeURIComponent(path);
}

export function glHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

function messageOf(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const b = body as { message?: unknown; error?: unknown; error_description?: unknown };
    const m = b.message ?? b.error_description ?? b.error;
    if (typeof m === "string") return `GitLab: ${m}`;
    if (m && typeof m === "object") return `GitLab: ${JSON.stringify(m)}`;
  }
  return `GitLab returned ${status}.`;
}

/**
 * A request to the API, as `path` below /api/v4. Throws a VcsError with
 * GitLab's own message and the status when it refuses; a 404 the caller
 * expects can be read as null with `allow404`.
 */
export async function gl<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; allow404?: boolean; raw?: boolean } = {},
): Promise<T> {
  const res = await fetch(`${GITLAB_API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...glHeaders(token),
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  }).catch((e: unknown) => {
    throw new VcsError(`Could not reach GitLab: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (res.status === 404 && init.allow404) return null as T;
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new VcsError(messageOf(body, res.status), res.status);
  }
  if (init.raw) return (await res.text()) as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** The raw bytes at `path`, or null on a 404. */
export async function glBytes(token: string, path: string): Promise<Buffer | null> {
  const res = await fetch(`${GITLAB_API}${path}`, { headers: glHeaders(token), cache: "no-store" }).catch(
    (e: unknown) => {
      throw new VcsError(`Could not reach GitLab: ${e instanceof Error ? e.message : String(e)}`);
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new VcsError(messageOf(body, res.status), res.status);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Every item of a paged listing, up to `maxPages` pages of 100. `path` may
 * already carry a query string.
 */
export async function glPages<T>(token: string, path: string, maxPages = MAX_PAGES): Promise<T[]> {
  const out: T[] = [];
  const join = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const batch = await gl<T[]>(token, `${path}${join}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}
