import { repository } from "@/lib/db";
import {
  appConfig,
  exchangeCode,
  fetchProfile,
  isAllowed,
  storeTokens,
} from "@/lib/auth/github";
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  cookieHeader,
  safeNext,
  signSession,
  verifyValue,
} from "@/lib/auth/session";
import { publicUrl } from "@/lib/origin";

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

/** GitHub sends people back here with a code. Trade it, and sign them in. */
export async function GET(req: Request) {
  if (!appConfig()) return Response.redirect(publicUrl("/", req), 303);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const remembered = await verifyValue(readCookie(req, OAUTH_COOKIE));
  const [nonce, next] = remembered?.split("|") ?? [];
  if (!code || !state || !nonce || state !== nonce) {
    return fail(req, "Sign-in expired or came from somewhere else. Try again.");
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

  const repo = repository();
  const first = (await repo.countUsers()) === 0;
  const user = await repo.upsertUser(profile);
  await storeTokens(user.id, tokens);
  // The first person to sign in is whoever set this deployment up: they
  // inherit the boards and agents made before accounts existed.
  if (first) await repo.adoptUnowned(user.id);

  const res = new Response(null, { status: 303, headers: { Location: safeNext(next ?? "/") } });
  res.headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, await signSession(user.id, Date.now(), user.sessionVersion), SESSION_MAX_AGE_S));
  res.headers.append("Set-Cookie", cookieHeader(OAUTH_COOKIE, "", 0));
  return res;
}
