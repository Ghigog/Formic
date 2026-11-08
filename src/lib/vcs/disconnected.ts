import type { VcsClient } from "./types";
import type { RepoHost } from "./host";

/** Said wherever work on a repository needs a GitHub connection the person doesn't have. */
export const GITHUB_NOT_CONNECTED =
  "GitHub isn't connected for this board. Connect GitHub in Settings, then try again.";

/** The same, for a board on a gitlab.com project. */
export const GITLAB_NOT_CONNECTED =
  "GitLab isn't connected for this board. Connect GitLab in Settings, then try again.";

export class GitHubNotConnectedError extends Error {
  constructor(message: string = GITHUB_NOT_CONNECTED) {
    super(message);
    this.name = "GitHubNotConnectedError";
  }
}

/**
 * The client for a repository when, with accounts, the person has no GitHub
 * token. Every call fails with a message that says why. It is never the mock:
 * a mock would let real agents "succeed" against a repository nobody can
 * reach, and the board would show work that never happened.
 */
export function disconnectedVcs(host: RepoHost = "github"): VcsClient {
  const message = host === "gitlab" ? GITLAB_NOT_CONNECTED : GITHUB_NOT_CONNECTED;
  return new Proxy({ name: "disconnected" } as VcsClient, {
    get(target, prop) {
      if (prop === "name") return target.name;
      // Not a thenable: awaiting the client itself must not call `then`.
      if (prop === "then") return undefined;
      return () => Promise.reject(new GitHubNotConnectedError(message));
    },
  });
}
