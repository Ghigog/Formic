/**
 * Which host a board's repository lives on, read from its name.
 *
 * A GitHub repository is named as GitHub names it, `owner/repo`. A gitlab.com
 * project is named `gitlab:group/project` (groups can nest, so the path may
 * have more than one slash). The prefix keeps the two apart wherever a
 * repository name travels, without a column of its own: a GitHub name can
 * never start with it, since GitHub owners cannot contain a colon.
 *
 * No server imports: the board's pages build links from these too.
 */

export type RepoHost = "github" | "gitlab";

export const GITLAB_PREFIX = "gitlab:";

const GITLAB_PATH = /^[\w.-]+(\/[\w.-]+)+$/;

export function repoHost(repoFullName: string): RepoHost {
  return repoFullName.startsWith(GITLAB_PREFIX) ? "gitlab" : "github";
}

/** The repository's path on its host: `owner/repo`, or a GitLab project's `group/project`. */
export function repoPath(repoFullName: string): string {
  return repoHost(repoFullName) === "gitlab" ? repoFullName.slice(GITLAB_PREFIX.length) : repoFullName;
}

/** A board's name for a gitlab.com project at `path`. */
export function gitlabRepo(path: string): string {
  return `${GITLAB_PREFIX}${path}`;
}

/**
 * A gitlab.com project path from what was pasted (`group/project`, its URL,
 * with or without `.git`, or the SSH remote), or null.
 */
export function normalizeGitlabPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw
    .trim()
    .replace(/^gitlab:/i, "")
    .replace(/^git@gitlab\.com:/i, "")
    .replace(/^(https?:\/\/)?(www\.)?gitlab\.com\//i, "")
    .replace(/\/-\/.*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return GITLAB_PATH.test(value) ? value : null;
}

/** The repository's page on its host. */
export function repoWebUrl(repoFullName: string): string {
  return repoHost(repoFullName) === "gitlab"
    ? `https://gitlab.com/${repoPath(repoFullName)}`
    : `https://github.com/${repoFullName}`;
}

/** What a person calls the host, for sentences. */
export function hostName(host: RepoHost): string {
  return host === "gitlab" ? "GitLab" : "GitHub";
}

/** What runs agents on that host, for sentences. */
export function ciName(host: RepoHost): string {
  return host === "gitlab" ? "GitLab CI" : "GitHub Actions";
}

/** What a reviewable change is called on that host. */
export function changeRequestName(host: RepoHost): string {
  return host === "gitlab" ? "merge request" : "pull request";
}
