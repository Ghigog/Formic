import "server-only";

import { env } from "@/lib/secrets/env";

/** A repository the configured GitHub token can reach. */
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
/** Enough for the picker. Most recently pushed first, so the long tail is old. */
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

/**
 * Every repository the token can see, most recently pushed first. A
 * fine-grained token scoped to a few repositories returns just those, which
 * is the point: the picker offers what agents can actually push to.
 */
export async function listRepositories(): Promise<
  { ok: true; repos: RepoOption[] } | { ok: false; reason: string }
> {
  const token = env().GITHUB_TOKEN;
  if (!token) {
    return {
      ok: false,
      reason: "Set GITHUB_TOKEN to list your repositories. You can still type owner/repo.",
    };
  }

  const repos: RepoOption[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `${API}/user/repos?per_page=100&sort=pushed&page=${page}`,
      { headers: headers(token), cache: "no-store" },
    ).catch(() => null);
    if (!res) return { ok: false, reason: "Could not reach GitHub." };
    if (!res.ok) {
      return {
        ok: false,
        reason: `GitHub refused the repository list (${res.status}). Check GITHUB_TOKEN.`,
      };
    }
    const batch = (await res.json()) as RawRepo[];
    repos.push(...batch.map(toOption));
    if (batch.length < 100) break;
  }
  return { ok: true, repos };
}

/** One repository, for its default branch. Null when the token cannot see it. */
export async function getRepository(fullName: string): Promise<RepoOption | null> {
  const token = env().GITHUB_TOKEN;
  if (!token) return null;
  const res = await fetch(`${API}/repos/${fullName}`, {
    headers: headers(token),
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return null;
  return toOption((await res.json()) as RawRepo);
}

/**
 * Directories in a repository, two levels deep, for the Architect Agent to
 * ground file scopes in. Null when the token cannot read it.
 */
export async function directoryTree(
  fullName: string,
  branch: string,
): Promise<string[] | null> {
  const token = env().GITHUB_TOKEN;
  if (!token) return null;
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
