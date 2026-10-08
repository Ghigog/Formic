import "server-only";

import { signValue } from "@/lib/auth/session";

/**
 * Tells open boards that something changed, through Supabase Realtime.
 *
 * On a serverless host the server can't push to a browser without holding a
 * function open for as long as the board is, which is what spent the Hobby
 * plan's function time. Supabase holds those connections instead: when an
 * event is published, the server broadcasts one empty "changed" message on
 * the board's channel, and each open board fetches what changed from
 * /api/events once. Between messages a board costs nothing.
 *
 * No board data goes through Supabase. The channel name is signed from the
 * project id with the app's secret, and only a signed-in person is told it,
 * so nobody else can listen, and a forged ping only makes a board look.
 *
 * On when a Supabase URL and key are set (the Vercel integration sets them);
 * FORMIC_REALTIME=off turns it off.
 */

export interface RealtimeConfig {
  /** The project's https address, such as https://abc.supabase.co. */
  url: string;
  /** The public (anon or publishable) key a browser connects with. */
  key: string;
}

/** The one event sent on a board's channel. */
export const CHANGED = "changed";

/** Log-line pings are sent at most this often per board; state changes always. */
export const LOG_PING_EVERY_MS = 2_000;
const SEND_TIMEOUT_MS = 1_500;

export function realtimeConfig(): RealtimeConfig | null {
  if (process.env.FORMIC_REALTIME?.trim().toLowerCase() === "off") return null;
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const key = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    ""
  ).trim();
  if (!/^https:\/\/[^/\s]+$/.test(url.replace(/\/+$/, "")) || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

/** A board's channel: not guessable without the app's secret. */
export async function realtimeTopic(projectId: string): Promise<string> {
  const signed = await signValue(`realtime:${projectId}`);
  return `formic-${signed.slice(signed.lastIndexOf(".") + 1, signed.lastIndexOf(".") + 41)}`;
}

const lastPing = new Map<string, number>();

/**
 * Broadcasts "changed" on a board's channel. Never throws, and gives up after
 * SEND_TIMEOUT_MS: a board that misses a ping finds the change on its next
 * look anyway.
 */
export async function pingBoards(projectId: string, droppable: boolean, now = Date.now()): Promise<void> {
  const config = realtimeConfig();
  if (!config) return;
  if (droppable && now - (lastPing.get(projectId) ?? -Infinity) < LOG_PING_EVERY_MS) return;
  lastPing.set(projectId, now);

  // The server key, when there is one, can send even where the project
  // refuses broadcasts from the public key.
  const serverKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "").trim();
  const key = serverKey || config.key;
  try {
    const res = await fetch(`${config.url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        messages: [{ topic: await realtimeTopic(projectId), event: CHANGED, payload: {} }],
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) console.warn(`[formic] realtime ping refused: ${res.status}`);
  } catch (e) {
    console.warn("[formic] realtime ping failed:", e instanceof Error ? e.message : e);
  }
}

/** For tests. */
export function resetRealtimeForTests(): void {
  lastPing.clear();
}
