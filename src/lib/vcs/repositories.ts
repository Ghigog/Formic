import "server-only";

/** A repository someone can point the board at. */
export interface RepoOption {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
  pushedAt: string | null;
}

interface RawRepo {
  full_name: string;
  default_branch: string;
  private: boolean;
  description: string | null;
  pushed_at: string | null;
}

const API = "https://api.github.com";
/** Enough for the picker. */
const MAX_PAGES = 3;

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function toOption(r: RawRepo): RepoOption {
  return {
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private,
    description: r.description,
    pushedAt: r.pushed_at,
  };
}

async function pages<T>(
  token: string,
  url: (page: number) => string,
  pick: (body: unknown) => T[],
): Promise<T[] | { error: string }> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(url(page), { headers: headers(token), cache: "no-store" }).catch(
      () => null,
    );
    if (!res) return { error: "Could not reach GitHub." };
    if (!res.ok) return { error: `GitHub refused the repository list (${res.status}).` };
    const batch = pick(await res.json());
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/**
 * The repositories a token can work on, most recently pushed first.
 *
 * A GitHub App user token sees exactly the repositories where the person has
 * installed the app, which is the point: the picker offers what agents can
 * actually push to. A personal token (local mode) sees what it was granted.
 */
export async function listRepositories(
  token: string,
  kind: "app" | "pat",
): Promise<{ ok: true; repos: RepoOption[] } | { ok: false; reason: string }> {
  if (kind === "pat") {
    const repos = await pages(
      token,
      (p) => `${API}/user/repos?per_page=100&sort=pushed&page=${p}`,
      (b) => (b as RawRepo[]).map(toOption),
    );
    return "error" in repos ? { ok: false, reason: repos.error } : { ok: true, repos };
  }

  const installations = await pages(
    token,
    (p) => `${API}/user/installations?per_page=100&page=${p}`,
    (b) => (b as { installations: Array<{ id: number }> }).installations,
  );
  if ("error" in installations) return { ok: false, reason: installations.error };

  const repos: RepoOption[] = [];
  for (const inst of installations) {
    const found = await pages(
      token,
      (p) => `${API}/user/installations/${inst.id}/repositories?per_page=100&page=${p}`,
      (b) => (b as { repositories: RawRepo[] }).repositories.map(toOption),
    );
    if ("error" in found) return { ok: false, reason: found.error };
    repos.push(...found);
  }
  repos.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  return { ok: true, repos };
}

/** One repository, for its real name and default branch. Null if unseen. */
export async function getRepository(fullName: string, token: string): Promise<RepoOption | null> {
  const res = await fetch(`${API}/repos/${fullName}`, {
    headers: headers(token),
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return null;
  return toOption((await res.json()) as RawRepo);
}

/** A name GitHub accepts for a new repository. */
export const REPO_NAME = /^[\w.-]{1,100}$/;

/**
 * A new private repository on the person's own account, with a first commit
 * so it has a default branch for agents to branch from. Needs the app's
 * Administration permission, or the "repo" scope on a personal token.
 */
export async function createRepository(
  name: string,
  token: string,
): Promise<{ ok: true; repo: RepoOption } | { ok: false; reason: string }> {
  const res = await fetch(`${API}/user/repos`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name, private: true, auto_init: true }),
    cache: "no-store",
  }).catch(() => null);
  if (!res) return { ok: false, reason: "Could not reach GitHub." };
  if (res.ok) return { ok: true, repo: toOption((await res.json()) as RawRepo) };
  if (res.status === 422) {
    return { ok: false, reason: `You already have a repository called ${name}.` };
  }
  if (res.status === 403 || res.status === 404) {
    return {
      ok: false,
      reason:
        "GitHub won't let Formic create repositories yet. Accept Formic's updated permissions on GitHub, then try again.",
    };
  }
  return { ok: false, reason: `GitHub refused to create the repository (${res.status}).` };
}

/**
 * Directories in a repository, two levels deep, for the Architect Agent to
 * ground file scopes in. Null when the token cannot read it.
 */
export async function directoryTree(
  fullName: string,
  branch: string,
  token: string,
): Promise<string[] | null> {
  const res = await fetch(
    `${API}/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers: headers(token), cache: "no-store" },
  ).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json()) as { tree?: Array<{ path: string; type: string }> };
  return (body.tree ?? [])
    .filter((e) => e.type === "tree" && e.path.split("/").length <= 2)
    .filter((e) => !/(^|\/)(node_modules|\.git|dist|build|\.next)(\/|$)/.test(e.path))
    .map((e) => e.path)
    .slice(0, 200);
}
