import { repository } from "@/lib/db";
import {
  appConfig,
  exchangeCode,
  fetchProfile,
  isAllowed,
  revokeToken,
  storeTokens,
} from "@/lib/auth/github";
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  cookieHeader,
  safeNext,
  secretProblem,
  signSession,
  verifyValue,
} from "@/lib/auth/session";
import { publicUrl } from "@/lib/origin";
import { firstSignIn, userForSession } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function fail(req: Request, message: string): Response {
  const back = publicUrl("/login", req);
  back.searchParams.set("error", message);
  const res = new Response(null, { status: 303, headers: { Location: back.toString() } });
  res.headers.append("Set-Cookie", cookieHeader(OAUTH_COOKIE, "", 0));
  return res;
}

/** Back to Settings with a message: how a connect that went wrong ends. */
function connectFailed(req: Request, message: string): Response {
  const back = publicUrl("/settings", req);
  back.searchParams.set("github_error", message);
  const res = new Response(null, { status: 303, headers: { Location: back.toString() } });
  res.headers.append("Set-Cookie", cookieHeader(OAUTH_COOKIE, "", 0));
  return res;
}

/** The OAuth state: a nonce, where to go after, and for a connect, whose account it is for. */
function parseState(value: string | null): { nonce?: string; next?: string; connectFor?: string } {
  const parts = value?.split("|") ?? [];
  const last = parts.at(-1) ?? "";
  const connectFor = parts.length >= 3 && last.startsWith("connect:") ? last.slice("connect:".length) : undefined;
  const middle = parts.slice(1, connectFor === undefined ? undefined : -1).join("|");
  return { nonce: parts[0], next: parts.length > 1 ? middle : undefined, connectFor };
}

/**
 * GitHub sends people back here with a code. Trade it, then either sign them
 * in (as today), or, for a connect, attach GitHub to the account that asked.
 * A connect never signs anyone in and never makes an account.
 */
export async function GET(req: Request) {
  if (!appConfig()) return Response.redirect(publicUrl("/", req), 303);
  const problem = secretProblem();
  if (problem) return fail(req, problem);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const remembered = await verifyValue(readCookie(req, OAUTH_COOKIE));
  const { nonce, next, connectFor } = parseState(remembered);
  if (!code || !state || !nonce || state !== nonce) {
    return fail(req, "Sign-in expired or came from somewhere else. Try again.");
  }

  if (connectFor !== undefined) {
    // Whoever started the connect must be who is signed in now: a callback
    // URL handed to someone else must not attach GitHub to their account.
    const user = await userForSession(readCookie(req, SESSION_COOKIE));
    if (!user || user.id !== connectFor) {
      return connectFailed(req, "That GitHub connection was started from another session. Try again.");
    }
    let tokens;
    let profile;
    try {
      tokens = await exchangeCode(code, publicUrl("/api/auth/github/callback", req).toString());
      profile = await fetchProfile(tokens.accessToken);
    } catch (e) {
      return connectFailed(req, e instanceof Error ? e.message : "Connecting GitHub failed.");
    }
    const repo = repository();
    const holder = await repo.userByGithubId(profile.githubId);
    if (holder && holder.id !== user.id) {
      await revokeToken(tokens.accessToken);
      return connectFailed(
        req,
        `@${profile.login} is already connected to another Formic account. Sign in with GitHub to use that one, or disconnect it there first.`,
      );
    }
    if (!holder) await repo.linkGithub(user.id, profile);
    await storeTokens(user.id, tokens);
    const res = new Response(null, { status: 303, headers: { Location: safeNext(next ?? "/settings") } });
    res.headers.append("Set-Cookie", cookieHeader(OAUTH_COOKIE, "", 0));
    return res;
  }

  let tokens;
  let profile;
  try {
    tokens = await exchangeCode(code, publicUrl("/api/auth/github/callback", req).toString());
    profile = await fetchProfile(tokens.accessToken);
  } catch (e) {
    return fail(req, e instanceof Error ? e.message : "GitHub sign-in failed.");
  }

  if (!isAllowed(profile.login)) {
    return fail(req, `${profile.login} is not on this Formic's list of allowed users. Ask whoever runs it to add them to FORMIC_ALLOWED_USERS.`);
  }

  const user = await firstSignIn(() => repository().upsertUser(profile));
  await storeTokens(user.id, tokens);

  const res = new Response(null, { status: 303, headers: { Location: safeNext(next ?? "/") } });
  res.headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, await signSession(user.id, Date.now(), user.sessionVersion), SESSION_MAX_AGE_S));
  res.headers.append("Set-Cookie", cookieHeader(OAUTH_COOKIE, "", 0));
  return res;
}
