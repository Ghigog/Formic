import type { ProviderInfo } from "./providers";

/**
 * ClinePass's *plan* credential, and keeping it alive.
 *
 * A ClinePass account has two wallets. The durable API key under
 * `app.cline.bot` > Settings > API Keys bills the **API balance**, which a plan
 * holder has never funded: a call with one answers `402 insufficient_credits` on
 * its first turn. What the $9.99 plan answers to is the **account session** the
 * Cline extension and CLI mint for themselves — a WorkOS JWT — together with the
 * `cline-pass/…` model slugs (see providers.ts).
 *
 * That session expires, which is why a person who pastes it is pasting again an
 * hour later. This refreshes it instead, from the session's own refresh token,
 * and keeps the count of hours at zero.
 *
 * The grant is the CLI's own, made for real against WorkOS on 6 October 2026:
 * one POST, no client secret, and a **rotated refresh token** in the reply —
 * which is kept, because a refresh that throws its replacement away works
 * exactly once and then locks the account out of its own session.
 */

const TOKEN_URL = "https://api.workos.com/user_management/authenticate";

/**
 * The client ClinePass signs in with. Cline's CLI bundle names two others
 * (`client_01K3A5415VF6QBQBG3XYCW91G6`, `client_01K6XQAY7JK6T5HXVSZW2S5VYK`);
 * both answer `400 invalid_grant`, so they are not this one.
 */
const CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

/** Refresh this long before the expiry, so a call already in flight is not left behind. */
const EARLY_MS = 10 * 60_000;

/** Assumed life of a token we cannot read an expiry out of. */
const ASSUMED_MS = 30 * 60_000;

interface Refresh {
  accessToken: string;
  /** The reply's replacement. The one that was sent is retired by rotation. */
  refreshToken: string;
  expiresAt: number;
}

/** The session held for one credential, and the credential it belongs to. */
let held: Refresh | null = null;
let heldFor: string | null = null;

/**
 * Credentials that are not sessions at all — a durable API key — remembered so
 * that every model call does not spend a round trip discovering it again.
 */
const notSessions = new Set<string>();

/** When a JWT says it expires; a rounded guess for anything else. */
function expiryOf(token: string): number {
  try {
    const payload = token.split(".")[1];
    if (!payload) return Date.now() + ASSUMED_MS;
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return exp ? exp * 1000 : Date.now() + ASSUMED_MS;
  } catch {
    return Date.now() + ASSUMED_MS;
  }
}

/**
 * The credential to call with: a live access token for a ClinePass session, and
 * the credential itself for everything else. Only ClinePass is touched.
 *
 * `force` refreshes even when the held token still looks good — what the caller
 * does when the gateway has just refused it.
 */
export async function liveToken(
  provider: ProviderInfo,
  credential: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  if (provider.id !== "clinepass" || !credential || notSessions.has(credential)) return credential;
  const mine = heldFor === credential ? held : null;

  if (!opts.force) {
    // The credential as it is, or the session an earlier refresh handed us while
    // it still has time. Nothing is spent finding out which: a credential that
    // needs refreshing says so by being refused — see `chat` in openai-compat.ts.
    return mine && Date.now() < mine.expiresAt - EARLY_MS ? mine.accessToken : credential;
  }

  // Forced: the gateway has just refused what we sent. Its own rotated refresh
  // token is the one to present — rotation retires the token that was pasted —
  // and a credential that is not a session at all answers 400 here and is left
  // alone from then on.
  let refreshed: Refresh | null = null;
  try {
    refreshed = await refreshSession(mine?.refreshToken ?? credential);
  } catch {
    // Could not ask, which is not the same as being refused: nothing is
    // remembered against the credential, and the call is made as it was.
    return credential;
  }
  if (!refreshed) {
    notSessions.add(credential);
    return credential;
  }
  held = refreshed;
  heldFor = credential;
  return refreshed.accessToken;
}

/**
 * One refresh grant, as the CLI makes it. Null when there is nothing to refresh
 * — a durable API key answers 400 — which is what tells `liveToken` to leave it
 * alone rather than spend a round trip per call.
 */
export async function refreshSession(refreshToken: string): Promise<Refresh | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) {
      // Refused out loud. A credential pasted out of the CLI's own file is
      // retired the moment the CLI refreshes that file — which it does every
      // hour, and on every command — so the copy here goes stale on its own,
      // and the run only fails later and elsewhere. Say so where it happens.
      console.warn(
        `[formic] ClinePass refused this session refresh (HTTP ${res.status}): paste the current refresh token from ~/.cline/data/settings/providers.json, or a live access token, into the agent.`,
      );
      return null;
    }

    const body = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (!body.access_token) return null;

    const refreshed: Refresh = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? refreshToken,
      expiresAt: expiryOf(body.access_token),
    };

    // Said out loud, once per refresh: a person whose board has just gone quiet
    // should be able to see that this is what it was doing. It lands in the
    // server's own log — for the desktop app, ~/Library/Logs/Formic.log.
    console.info(
      `[formic] ClinePass plan session refreshed; live until ${new Date(refreshed.expiresAt).toLocaleTimeString()}.`,
    );
    return refreshed;
  } catch {
    return null;
  }
}
