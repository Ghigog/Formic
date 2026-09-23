import "server-only";

import { repository } from "@/lib/db";
import type { FormicEvent, SequencedEvent } from "@/lib/domain/events";
import { redactDeep } from "@/lib/secrets/redact";
import { syncIssues } from "@/lib/issues/sync";

/**
 * In-process pub/sub with a durable tail.
 *
 * Every event is appended to the `event` table before it is delivered, so a
 * client that reconnects can ask for everything after the last sequence it saw
 * instead of showing a gap. Delivery itself is best-effort: a subscriber whose
 * queue is full loses log lines, never state changes (see `isDroppable`).
 *
 * Single-process only. Running more than one Next.js instance needs this
 * swapped for Postgres LISTEN/NOTIFY or Redis; the interface does not change.
 */

type Subscriber = (event: SequencedEvent) => void;

declare global {
  // eslint-disable-next-line no-var
  var __formicSubscribers: Map<string, Set<Subscriber>> | undefined;
}

function subscribers(): Map<string, Set<Subscriber>> {
  if (!globalThis.__formicSubscribers) {
    globalThis.__formicSubscribers = new Map();
  }
  return globalThis.__formicSubscribers;
}

export function subscribe(projectId: string, fn: Subscriber): () => void {
  const map = subscribers();
  const set = map.get(projectId) ?? new Set<Subscriber>();
  set.add(fn);
  map.set(projectId, set);

  return () => {
    set.delete(fn);
    if (set.size === 0) map.delete(projectId);
  };
}

export function subscriberCount(projectId: string): number {
  return subscribers().get(projectId)?.size ?? 0;
}

export async function publish(
  projectId: string,
  raw: FormicEvent,
): Promise<number> {
  // Single choke point for secret scrubbing. Everything the UI ever sees
  // passes through here, so redaction happens once rather than at every
  // call site that might log a command line or a clone URL.
  const event = redactDeep(raw);

  const seq = await repository().appendEvent(projectId, event.type, event);
  const sequenced: SequencedEvent = {
    seq,
    projectId,
    at: new Date().toISOString(),
    event,
  };

  for (const fn of subscribers().get(projectId) ?? []) {
    try {
      fn(sequenced);
    } catch {
      // A broken subscriber must not take down the publisher.
    }
  }

  // Card changes are mirrored onto GitHub issues, after the board has them.
  // Awaited, because a serverless function may stop once this returns; it
  // never throws.
  if (event.type === "card.status" || event.type === "card.created") {
    await syncIssues(projectId, event);
  }
  return seq;
}

/**
 * Log and diff frames are high-volume and individually worthless; state
 * changes are neither. Backpressure drops the former and never the latter.
 */
export function isDroppable(event: FormicEvent): boolean {
  return (
    event.type === "run.log" ||
    event.type === "run.diff" ||
    event.type === "run.progress" ||
    event.type === "run.usage"
  );
}

export async function replay(
  projectId: string,
  afterSeq: number,
): Promise<SequencedEvent[]> {
  const rows = await repository().eventsAfter(projectId, afterSeq);
  return rows.map((r) => ({
    seq: r.seq,
    projectId,
    at: r.at.toISOString(),
    event: r.payload as FormicEvent,
  }));
}
