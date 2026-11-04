import "server-only";

import type { Account } from "@/components/board/account-menu";
import type { UserRecord } from "@/lib/db/repository";
import { authMode, githubSignIn } from "./session";
import { isGithubLinked } from "./github";

/** What the header and Settings show about the person signed in. */
export function accountFor(user: UserRecord): Account {
  const accounts = authMode() === "accounts";
  const connected = isGithubLinked(user);
  return {
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl,
    signedIn: accounts,
    email: user.email,
    github: accounts
      ? { connected, canConnect: githubSignIn(), canDisconnect: connected && !!user.email }
      : null,
  };
}
