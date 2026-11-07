import { randomBytes } from "node:crypto";
import { GITLAB_CALLBACK_PATH, gitlabAuthorizeUrl, gitlabConfig } from "@/lib/auth/gitlab";
import { OAUTH_COOKIE, SESSION_COOKIE, cookieHeader, secretProblem, signValue } from "@/lib/auth/session";
import { userForSession } from "@/lib/auth/user";
import { limit, limited } from "@/lib/rate-limit";
import { publicUrl } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** Ten connects a minute from one address: the state round trip isn't free. */
const CONNECT = limit(10, 60_000);

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Back to Settings with a message: how a connect that cannot start ends. */
function back(req: Request, message: string): Response {
  const url = publicUrl("/settings", req);
  url.searchParams.set("gitlab_error", message);
  return Response.redirect(url, 303);
}

/**
 * Starts connecting a gitlab.com account to the signed-in person. GitLab is
 * never a way to sign in: the state names the account that asked, so the
 * callback attaches GitLab to it and to no other.
 */
export async function GET(req: Request) {
  const refused = limited(req, CONNECT, "gitlab-login");
  if (refused) return refused;
  if (!gitlabConfig()) return back(req, "GitLab isn't set up on this Formic yet.");
  const problem = secretProblem();
  if (problem) return back(req, problem);

  const user = await userForSession(readCookie(req, SESSION_COOKIE));
  if (!user) {
    const login = publicUrl("/login", req);
    login.searchParams.set("next", "/settings");
    return Response.redirect(login, 303);
  }

  const nonce = randomBytes(16).toString("hex");
  const state = `${nonce}|gitlab-connect:${user.id}`;
  const redirectUri = publicUrl(GITLAB_CALLBACK_PATH, req).toString();
  const res = new Response(null, { status: 303, headers: { Location: gitlabAuthorizeUrl(nonce, redirectUri) } });
  // GitLab hands the nonce back, and only this browser holds the cookie that matches it.
  res.headers.append("Set-Cookie", cookieHeader(OAUTH_COOKIE, encodeURIComponent(await signValue(state)), 600));
  return res;
}
