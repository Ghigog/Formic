import "server-only";

import { redact } from "@/lib/secrets/redact";
import { sendAlert } from "./alerts";

export type ErrorSource = "server" | "client";

export interface ErrorInput {
  message: string;
  stack?: string;
  route?: string;
  digest?: string;
  source: ErrorSource;
}

export interface TrackedError {
  message: string;
  stack?: string;
  route?: string;
  digest?: string;
  source: ErrorSource;
  commit: string | null;
  timestamp: string;
}

/** A burst worth paging someone about, not just logging. */
const SPIKE_WINDOW_MS = 5 * 60_000;
const SPIKE_THRESHOLD = 10;
const SPIKE_ALERT_COOLDOWN_MS = 15 * 60_000;

let recentErrorTimestamps: number[] = [];
let lastSpikeAlertAt = 0;

/**
 * Logs a redacted, structured error with its route and the commit serving
 * it, and alerts once a burst of them looks like a spike rather than one bad
 * request. This is the tracking surface both `onRequestError` (server) and
 * the client-error route (browser, forwarded via POST) report through, so
 * either source counts toward the same spike.
 */
export function trackError(input: ErrorInput): TrackedError {
  const record: TrackedError = {
    message: redact(input.message),
    stack: input.stack ? redact(input.stack) : undefined,
    route: input.route,
    digest: input.digest,
    source: input.source,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    timestamp: new Date().toISOString(),
  };

  console.error("[formic:error]", JSON.stringify(record));
  checkForSpike(record);
  return record;
}

/** Extracts a message and stack from whatever a route or React actually threw. */
export function trackThrown(
  error: unknown,
  context: { route?: string; digest?: string; source: ErrorSource },
): TrackedError {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return trackError({ message, stack, ...context });
}

function checkForSpike(record: TrackedError): void {
  const now = Date.now();
  recentErrorTimestamps.push(now);
  recentErrorTimestamps = recentErrorTimestamps.filter((t) => now - t < SPIKE_WINDOW_MS);

  if (recentErrorTimestamps.length < SPIKE_THRESHOLD) return;
  if (now - lastSpikeAlertAt < SPIKE_ALERT_COOLDOWN_MS) return;
  lastSpikeAlertAt = now;

  void sendAlert(
    `Error spike: ${recentErrorTimestamps.length} errors in the last ` +
      `${SPIKE_WINDOW_MS / 60_000} minutes. Latest on ${record.route ?? "an unknown route"}: ${record.message}`,
  );
}

/** Test-only: this module's spike counter is process-global by design. */
export function resetSpikeTrackingForTests(): void {
  recentErrorTimestamps = [];
  lastSpikeAlertAt = 0;
}
