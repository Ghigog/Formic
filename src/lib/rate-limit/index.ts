/**
 * A limit and the window it is counted over.
 */
export interface Limit {
  /** How many hits to allow. */
  max: number;
  /** The window's size in milliseconds. */
  windowMs: number;
}

export function limit(max: number, windowMs: number): Limit {
  return { max, windowMs };
}

/**
 * The budget shared by every route that starts an agent run — a transition,
 * a new Epic or ticket, a chat question, the assistant, a sentinel, a
 * repository that needs its setup run. Sixty starts a minute is far above
 * what one person dragging a board does, and far below what a hammer does.
 */
export const RUN = limit(60, 60_000);

/**
 * The board's own budget. A refresh of the board also launches the sweeps
 * (finished runs, open pull requests, idle cards), and the UI polls it —
 * so it gets a more generous bucket than the shared run budget, or normal
 * polling would starve it.
 */
export const REFRESH = limit(300, 60_000);

/**
 * The public surface can't be a free guessing game: /api/login takes password
 * guesses, GitHub sign-in hands out OAuth state, and starting agent runs
 * spends real money. Each address gets a fixed budget of hits per window.
 *
 * The count is kept in memory, per process, in whole windows: a bucket is
 * the window's start time and a hit count. That trades the precision of a
 * rolling window and the durability of a store for having nothing to
 * configure — on a serverless platform every instance enforces its own
 * share of the limit, which still leaves guessing far from free.
 */

const buckets = new Map<string, { window: number; hits: number }>();

export function clearBuckets() {
  buckets.clear();
}

/** The address a request came from, as the platform in front of it reports it. */
export function clientAddress(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",").pop()!.trim();
  // Vercel sets both; the proxy's own header can't be sent by the visitor.
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "";
}

function keyFor(name: string, req: Request) {
  return `${name}:${clientAddress(req) || "unknown"}`;
}

/**
 * Charges one hit against the limit, and returns a 429 refusing the request
 * when the window's budget is spent, or null when it goes through.
 */
export function limited(req: Request, limit: Limit, name: string, now = Date.now()): Response | null {
  const window = Math.floor(now / limit.windowMs);
  const key = keyFor(name, req);
  const bucket = buckets.get(key);
  if (bucket && bucket.window === window && bucket.hits >= limit.max) {
    const retryAfterS = Math.max(1, Math.ceil(((window + 1) * limit.windowMs - now) / 1000));
    return Response.json(
      { error: "Too many attempts. Try again in a minute." },
      { status: 429, headers: { "Retry-After": String(retryAfterS) } },
    );
  }
  buckets.set(
    key,
    bucket && bucket.window === window ? { ...bucket, hits: bucket.hits + 1 } : { window, hits: 1 },
  );
  return null;
}
