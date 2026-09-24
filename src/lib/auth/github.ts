import "server-only";

import { repository } from "@/lib/db";
import type { GithubProfile, UserRecord } from "@/lib/db/repository";
import { open, seal } from "@/lib/secrets/vault";

/**
 * Signing in with the GitHub App, and keeping each person's GitHub token
 * fresh. The token is a user-to-server token: it acts as that person, and
 * only on repositories where they have installed the app. It expires after
 * eight hours and is refreshed here, so a run started by a webhook at 3am
 * still has a working credential.
 */

const OAUTH = "https://github.com/login/oauth";
const API = "https://api.github.com";
/** Refresh this long before expiry, so a token never dies mid-request. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function appConfig() {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, slug: process.env.GITHUB_APP_SLUG || null };
}

/** Where someone grants the app access to more repositories. */
export function installUrl(): string | null {
  const slug = appConfig()?.slug;
  return slug ? `https://github.com/apps/${slug}/installations/new` : null;
}

export function authorizeUrl(state: string, redirectUri: string): string {
  const config = appConfig();
  if (!config) throw new Error("No GitHub App is configured.");
  const url = new URL(`${OAUTH}/authorize`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  expiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const config = appConfig();
  if (!config) throw new Error("No GitHub App is configured.");
  const res = await fetch(`${OAUTH}/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...params,
    }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `GitHub returned ${res.status}.`);
  }
  const now = Date.now();
  return {
    accessToken: body.access_token,
    expiresAt: body.expires_in ? new Date(now + body.expires_in * 1000) : null,
    refreshToken: body.refresh_token ?? null,
    refreshExpiresAt: body.refresh_token_expires_in
      ? new Date(now + body.refresh_token_expires_in * 1000)
      : null,
  };
}

export function exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
  return tokenRequest({ code, redirect_uri: redirectUri });
}

export function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function fetchProfile(token: string): Promise<GithubProfile> {
  const res = await fetch(`${API}/user`, { headers: githubHeaders(token), cache: "no-store" });
  if (!res.ok) throw new Error(`GitHub would not say who you are (${res.status}).`);
  const u = (await res.json()) as {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string | null;
  };
  return { githubId: u.id, login: u.login, name: u.name, avatarUrl: u.avatar_url };
}

/** FORMIC_ALLOWED_USERS, when set, is the only people who may sign in. */
export function isAllowed(login: string): boolean {
  const list = (process.env.FORMIC_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length === 0 || list.includes(login.toLowerCase());
}

export async function storeTokens(userId: string, tokens: TokenSet): Promise<UserRecord> {
  return repository().updateUser(userId, {
    githubTokenCipher: seal(tokens.accessToken),
    githubTokenExpiresAt: tokens.expiresAt,
    githubRefreshCipher: tokens.refreshToken ? seal(tokens.refreshToken) : null,
    githubRefreshExpiresAt: tokens.refreshExpiresAt,
  });
}

/**
 * Revokes a GitHub App user-to-server token, so it stops working at GitHub's
 * end too, not only in Formic's database. Best-effort: account deletion goes
 * ahead either way, since the token is deleted here regardless.
 */
export async function revokeToken(token: string): Promise<void> {
  const config = appConfig();
  if (!config) return;
  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  try {
    const res = await fetch(`${API}/applications/${config.clientId}/token`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: token }),
      cache: "no-store",
    });
    if (!res.ok && res.status !== 404) {
      console.error(`[formic] could not revoke a GitHub token (${res.status}).`);
    }
  } catch (e) {
    console.error("[formic] could not revoke a GitHub token:", e);
  }
}

/**
 * A working GitHub token for this person, refreshed if it is about to
 * expire. Null when they have none, or it lapsed past its refresh window:
 * they need to sign in again.
 */
export async function githubTokenFor(user: UserRecord, now = Date.now()): Promise<string | null> {
  const token = user.githubTokenCipher ? open(user.githubTokenCipher) : null;
  const expires = user.githubTokenExpiresAt?.getTime() ?? null;
  if (token && (expires === null || expires - REFRESH_MARGIN_MS > now)) return token;

  const refresh = user.githubRefreshCipher ? open(user.githubRefreshCipher) : null;
  const refreshExpires = user.githubRefreshExpiresAt?.getTime() ?? null;
  if (!refresh || (refreshExpires !== null && refreshExpires <= now)) return null;

  try {
    const fresh = await refreshTokens(refresh);
    await storeTokens(user.id, fresh);
    return fresh.accessToken;
  } catch (e) {
    console.error(`[formic] could not refresh the GitHub token for ${user.login}:`, e);
    return null;
  }
}
