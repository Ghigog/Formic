import type { VcsClient } from "./types";

/** Said wherever work on a repository needs a GitHub connection the person doesn't have. */
export const GITHUB_NOT_CONNECTED =
  "GitHub isn't connected for this board. Connect GitHub in Settings, then try again.";

export class GitHubNotConnectedError extends Error {
  constructor() {
    super(GITHUB_NOT_CONNECTED);
    this.name = "GitHubNotConnectedError";
  }
}

/**
 * The client for a repository when, with accounts, the person has no GitHub
 * token. Every call fails with a message that says why. It is never the mock:
 * a mock would let real agents "succeed" against a repository nobody can
 * reach, and the board would show work that never happened.
 */
export function disconnectedVcs(): VcsClient {
  return new Proxy({ name: "disconnected" } as VcsClient, {
    get(target, prop) {
      if (prop === "name") return target.name;
      // Not a thenable: awaiting the client itself must not call `then`.
      if (prop === "then") return undefined;
      return () => Promise.reject(new GitHubNotConnectedError());
    },
  });
}
