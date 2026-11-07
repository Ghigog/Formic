import { repository } from "@/lib/db";
import {
  GITLAB_CALLBACK_PATH,
  exchangeGitlabCode,
  fetchGitlabAccount,
  gitlabConfig,
  revokeGitlabToken,
  storeGitlabTokens,
} from "@/lib/auth/gitlab";
import { OAUTH_COOKIE, SESSION_COOKIE, cookieHeader, secretProblem, verifyValue } from "@/lib/auth/session";
import { publicUrl } from "@/lib/origin";
import { userForSession } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Back to Settings, with a message when it went wrong. */
function done(req: Request, error?: string): Response {
  const url = publicUrl("/settings", req);
  if (error) url.searchParams.set("gitlab_error", error);
  else url.searchParams.set("gitlab", "connected");
  const res = new Response(null, { status: 303, headers: { Location: url.toString() } });
  res.headers.append("Set-Cookie", cookieHeader(OAUTH_COOKIE, "", 0));
  return res;
}

/**
 * GitLab sends the person back here with a code. Trade it for a token and
 * attach the GitLab account to whoever started the connect, who must be
 * who is signed in now. Never signs anyone in and never makes an account.
 */
export async function GET(req: Request) {
  if (!gitlabConfig()) return done(req, "GitLab isn't set up on this Formic yet.");
  const problem = secretProblem();
  if (problem) return done(req, problem);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return done(req, "GitLab wasn't connected.");

  const remembered = (await verifyValue(readCookie(req, OAUTH_COOKIE))) ?? "";
  const [nonce, purpose] = remembered.split("|");
  const connectFor = purpose?.startsWith("gitlab-connect:") ? purpose.slice("gitlab-connect:".length) : null;
  if (!code || !state || !nonce || state !== nonce || !connectFor) {
    return done(req, "That GitLab connection expired or came from somewhere else. Try again.");
  }
  const user = await userForSession(readCookie(req, SESSION_COOKIE));
  if (!user || user.id !== connectFor) {
    return done(req, "That GitLab connection was started from another session. Try again.");
  }

  let tokens;
  let account;
  try {
    tokens = await exchangeGitlabCode(code, publicUrl(GITLAB_CALLBACK_PATH, req).toString());
    account = await fetchGitlabAccount(tokens.accessToken);
  } catch (e) {
    return done(req, e instanceof Error ? e.message : "Connecting GitLab failed.");
  }
  const repo = repository();
  const holder = await repo.userByGitlabId(account.gitlabId);
  if (holder && holder.id !== user.id) {
    await revokeGitlabToken(tokens.accessToken);
    return done(req, `@${account.login} is already connected to another Formic account. Disconnect it there first.`);
  }
  await repo.linkGitlab(user.id, account);
  await storeGitlabTokens(user.id, tokens);
  return done(req);
}
