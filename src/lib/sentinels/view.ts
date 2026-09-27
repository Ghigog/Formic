import type { AuditRecord, AuditReport } from "@/lib/db/repository";
import { SENTINELS } from "./roster";

/**
 * What the page knows about each sentinel: its last report, and a run in
 * progress or a failure newer than that report. No server imports.
 */

/** A run that has not moved for this long died with the function running it. */
export const STALE_AFTER_MS = 10 * 60_000;

export interface SentinelState {
  id: string;
  stars: number | null;
  quote: string | null;
  summary: string | null;
  report: AuditReport | null;
  /** When the report was written, ISO. */
  at: string | null;
  model: string | null;
  files: string[];
  running: { log: string[]; startedAt: string } | null;
  /** The newest run failed: why. The last report still stands. */
  error: string | null;
}

export type SentinelStates = Record<string, SentinelState>;

export function sentinelStates(audits: AuditRecord[], now = Date.now()): SentinelStates {
  const out: SentinelStates = {};
  for (const s of SENTINELS) {
    const mine = audits
      .filter((a) => a.sentinel === s.id)
      .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
    const done = mine.filter((a) => a.status === "done").at(-1) ?? null;
    const newest = mine.at(-1) ?? null;
    const later = newest && newest !== done ? newest : null;
    const stale =
      later?.status === "running" && now - new Date(later.startedAt).getTime() > STALE_AFTER_MS;
    out[s.id] = {
      id: s.id,
      stars: done?.stars ?? null,
      quote: done?.quote ?? null,
      summary: done?.summary ?? null,
      report: done?.report ?? null,
      at: done?.finishedAt ? new Date(done.finishedAt).toISOString() : null,
      model: done?.model ?? null,
      files: done?.files ?? [],
      running:
        later?.status === "running" && !stale
          ? { log: later.log, startedAt: new Date(later.startedAt).toISOString() }
          : null,
      error:
        later?.status === "failed"
          ? (later.error ?? "The audit failed.")
          : stale
            ? "The audit stopped without reporting. Run it again."
            : null,
    };
  }
  return out;
}

/** Each sentinel's stars, for gradeOf. */
export function starsOf(states: SentinelStates): Record<string, number | null> {
  return Object.fromEntries(Object.values(states).map((s) => [s.id, s.stars]));
}
