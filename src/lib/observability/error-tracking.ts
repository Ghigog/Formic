import "server-only";

import { redact } from "@/lib/secrets/redact";
import { randomUUID } from "node:crypto";
import { repository } from "@/lib/db";
import { resetMemoryStore } from "@/lib/db/memory-repository";
import { configuredOrigin } from "@/lib/origin";
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

/** Where to look when the spike alert fires. */
const RUNBOOK_URL = "https://github.com/Ghigog/Formic/blob/main/docs/runbook.md";

/**
 * Logs a redacted, structured error with its route and the commit serving
 * it, and alerts once a burst of them looks like a spike rather than one bad
 * request. This is the tracking surface both `onRequestError` (server) and
 * the client-error route (browser, forwarded via POST) report through, so
 * either source counts toward the same spike. Counted in the repository so
 * errors spread over several instances still add up; resolves once any alert
 * has been sent, and never throws.
 */
export async function trackError(input: ErrorInput): Promise<TrackedError> {
  const record: TrackedError = {
    message: redact(input.message),
    stack: input.stack ? redact(input.stack) : undefined,
    route: input.route,
    digest: input.digest,
    source: input.source,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.FORMIC_COMMIT ?? null,
    timestamp: new Date().toISOString(),
  };

  console.error("[formic:error]", JSON.stringify(record));
  try {
    await checkForSpike(record);
  } catch (e) {
    console.error("[formic] could not count error for spike check:", redact(String(e)));
  }
  return record;
}

/** Extracts a message and stack from whatever a route or React actually threw. */
export async function trackThrown(
  error: unknown,
  context: { route?: string; digest?: string; source: ErrorSource },
): Promise<TrackedError> {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return trackError({ message, stack, ...context });
}

async function checkForSpike(record: TrackedError): Promise<void> {
  const repo = repository();
  const count = await repo.recordErrorOccurrence(new Date(Date.now() - SPIKE_WINDOW_MS));
  if (count < SPIKE_THRESHOLD) return;
  // A fresh holder per call: only one instance wins each cooldown.
  if (!(await repo.acquireLease("error-spike-alert", randomUUID(), SPIKE_ALERT_COOLDOWN_MS))) return;

  await sendAlert(
    `Error spike on ${configuredOrigin() ?? "this board"}: ${count} errors in the last ` +
      `${SPIKE_WINDOW_MS / 60_000} minutes on commit ${record.commit ?? "unknown"}. ` +
      `Latest on ${record.route ?? "an unknown route"}: ${record.message}. ` +
      `Playbook: ${RUNBOOK_URL}`,
  );
}

/** Test-only: the counted errors and the alert cooldown live in the memory store. */
export function resetSpikeTrackingForTests(): void {
  resetMemoryStore();
}
