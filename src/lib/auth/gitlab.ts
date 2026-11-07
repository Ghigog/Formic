import "server-only";

import { repository } from "@/lib/db";
import type { GitlabAccount, UserRecord } from "@/lib/db/repository";
import { configuredOrigin } from "@/lib/origin";
import { open, seal } from "@/lib/secrets/vault";

/**
 * Connecting a gitlab.com account, and keeping its token fresh. People
 * always sign in to Formic by email first; GitLab is connected afterwards,
 * from Settings, the way GitHub can be. The token acts as that person, with
 * the `api` scope: it opens merge requests, starts pipelines and reads
 * them. It lasts two hours and is renewed here with the refresh token,
 * which GitLab replaces every time, so a run started at 3am still has a
 * working credential.
 *
 * gitlab.com only for now. A self-managed GitLab would add its own URL here.
 */

export const GITLAB_URL = "https://gitlab.com";
export const GITLAB_API = `${GITLAB_URL}/api/v4`;
/** Renew this long before expiry, so a token never dies mid-request. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const GITLAB_CALLBACK_PATH = "/api/auth/gitlab/callback";

/** Whether this person has a gitlab.com account connected. */
export function isGitlabLinked(user: Pick<UserRecord, "gitlabId">): boolean {
  return user.gitlabId !== null && user.gitlabId !== undefined;
}

/** The GitLab OAuth application this deployment uses, or null when there is none. */
export function gitlabConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GITLAB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITLAB_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function gitlabAuthorizeUrl(state: string, redirectUri: string): string {
  const config = gitlabConfig();
  if (!config) throw new Error("No GitLab application is configured.");
  const url = new URL(`${GITLAB_URL}/oauth/authorize`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "api");
  return url.toString();
}

export interface GitlabTokens {
  accessToken: string;
  expiresAt: Date | null;
  refreshToken: string | null;
}

async function tokenRequest(params: Record<string, string>): Promise<GitlabTokens> {
  const config = gitlabConfig();
  if (!config) throw new Error("No GitLab application is configured.");
  const res = await fetch(`${GITLAB_URL}/oauth/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...params }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `GitLab returned ${res.status}.`);
  }
  return {
    accessToken: body.access_token,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    refreshToken: body.refresh_token ?? null,
  };
}

export function exchangeGitlabCode(code: string, redirectUri: string): Promise<GitlabTokens> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

export function refreshGitlabTokens(refreshToken: string): Promise<GitlabTokens> {
  const origin = configuredOrigin();
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    ...(origin ? { redirect_uri: `${origin}${GITLAB_CALLBACK_PATH}` } : {}),
  });
}

export function gitlabHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

export async function fetchGitlabAccount(token: string): Promise<GitlabAccount> {
  const res = await fetch(`${GITLAB_API}/user`, { headers: gitlabHeaders(token), cache: "no-store" });
  if (!res.ok) throw new Error(`GitLab would not say who you are (${res.status}).`);
  const u = (await res.json()) as { id: number; username: string };
  return { gitlabId: u.id, login: u.username };
}

export async function storeGitlabTokens(userId: string, tokens: GitlabTokens): Promise<UserRecord> {
  return repository().updateUser(userId, {
    gitlabTokenCipher: seal(tokens.accessToken),
    gitlabTokenExpiresAt: tokens.expiresAt,
    gitlabRefreshCipher: tokens.refreshToken ? seal(tokens.refreshToken) : null,
  });
}

/** Revokes a GitLab token at GitLab's end too. Best-effort: Formic forgets it either way. */
export async function revokeGitlabToken(token: string): Promise<void> {
  const config = gitlabConfig();
  if (!config) return;
  try {
    const res = await fetch(`${GITLAB_URL}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, token }),
      cache: "no-store",
    });
    if (!res.ok) console.error(`[formic] could not revoke a GitLab token (${res.status}).`);
  } catch (e) {
    console.error("[formic] could not revoke a GitLab token:", e);
  }
}

/**
 * A working GitLab token for this person, renewed if it is about to expire.
 * Null when they have none, or the renewal was refused: they need to connect
 * GitLab again.
 */
export async function gitlabTokenFor(user: UserRecord, now = Date.now()): Promise<string | null> {
  const token = user.gitlabTokenCipher ? open(user.gitlabTokenCipher) : null;
  const expires = user.gitlabTokenExpiresAt?.getTime() ?? null;
  if (token && (expires === null || expires - REFRESH_MARGIN_MS > now)) return token;

  const refresh = user.gitlabRefreshCipher ? open(user.gitlabRefreshCipher) : null;
  if (!refresh) return null;

  // A refresh token works once, and GitLab hands back a new one with each
  // renewal. Two lookups that find the token expired at once must share one
  // renewal, or the second spends a token already spent and loses GitLab.
  let pending = refreshing.get(refresh);
  if (!pending) {
    pending = refreshAndStore(user, refresh).finally(() => refreshing.delete(refresh));
    refreshing.set(refresh, pending);
  }
  return pending;
}

const refreshing = new Map<string, Promise<string | null>>();

async function refreshAndStore(user: UserRecord, refresh: string): Promise<string | null> {
  try {
    const fresh = await refreshGitlabTokens(refresh);
    await storeGitlabTokens(user.id, fresh);
    return fresh.accessToken;
  } catch (e) {
    // Another instance may have renewed it first and stored what it got.
    const stored = await repository().userById(user.id);
    const token = stored?.gitlabTokenCipher ? open(stored.gitlabTokenCipher) : null;
    const expires = stored?.gitlabTokenExpiresAt?.getTime() ?? null;
    if (token && stored?.gitlabRefreshCipher !== user.gitlabRefreshCipher && (expires === null || expires > Date.now())) {
      return token;
    }
    console.error(`[formic] could not renew the GitLab token for ${user.login}:`, e);
    return null;
  }
}
