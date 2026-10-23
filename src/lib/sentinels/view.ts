import type { AuditKind, AuditRecord, AuditReport, Rubric } from "@/lib/db/repository";
import { SENTINELS } from "./roster";
import { sameRubric } from "./rubric";

/**
 * What the page knows about each sentinel: its rubric, its last report, and
 * a run in progress or a failure newer than those. No server imports.
 */

/** A run that has not moved for this long died with the function running it. */
export const STALE_AFTER_MS = 10 * 60_000;
/** A GitHub Actions job takes minutes to start and read the repository, and reports when it ends. */
export const STALE_JOB_AFTER_MS = 45 * 60_000;

export interface SentinelState {
  id: string;
  /** The report's audit, to mark when an Epic is made from it. */
  auditId: string | null;
  /** The Epic made from the current report, if any. */
  epicId: string | null;
  stars: number | null;
  quote: string | null;
  summary: string | null;
  report: AuditReport | null;
  /** The rubric the report was scored against, or null for one from before rubrics. */
  scoredWith: Rubric | null;
  /** When the report was written, ISO. */
  at: string | null;
  model: string | null;
  files: string[];
  /** The commit the report read, or null for an audit from before stamping or one that could not resolve it. */
  commitSha: string | null;
  /** The rubric the next audit is scored against, from the last calibration. */
  rubric: { rubric: Rubric; at: string | null; model: string | null } | null;
  /** Whether the report was scored against a rubric since replaced by calibrating again. */
  rubricChanged: boolean;
  /** Story points of tickets that reached Done since the report was written. */
  doneSince: number;
  /** Whether more than the sentinel's threshold shipped since the report: its stars describe older code. */
  auditStale: boolean;
  running: { kind: AuditKind; log: string[]; startedAt: string } | null;
  /** The newest run failed: why. The last report and rubric still stand. */
  error: string | null;
}

export type SentinelStates = Record<string, SentinelState>;

/** A ticket that reached Done: when, and its story points (0 when unestimated). */
export interface Shipped {
  doneAt: number;
  points: number;
}

export function sentinelStates(audits: AuditRecord[], now = Date.now(), shipped: Shipped[] = []): SentinelStates {
  const out: SentinelStates = {};
  for (const s of SENTINELS) {
    const mine = audits
      .filter((a) => a.sentinel === s.id)
      .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
    const done = mine.filter((a) => a.kind === "audit" && a.status === "done").at(-1) ?? null;
    const calibrated = mine.filter((a) => a.kind === "calibrate" && a.status === "done" && a.rubric).at(-1) ?? null;
    const newest = mine.at(-1) ?? null;
    const later = newest && newest !== done && newest !== calibrated ? newest : null;
    const stale =
      later?.status === "running" &&
      now - new Date(later.startedAt).getTime() > (later.runnerJob ? STALE_JOB_AFTER_MS : STALE_AFTER_MS);
    const finishedAt = done?.finishedAt ? new Date(done.finishedAt).getTime() : null;
    const doneSince =
      finishedAt === null ? 0 : shipped.filter((t) => t.doneAt > finishedAt).reduce((n, t) => n + t.points, 0);
    out[s.id] = {
      id: s.id,
      auditId: done?.id ?? null,
      epicId: done?.epicId ?? null,
      stars: done?.stars ?? null,
      quote: done?.quote ?? null,
      summary: done?.summary ?? null,
      report: done?.report ?? null,
      scoredWith: done?.rubric ?? null,
      at: done?.finishedAt ? new Date(done.finishedAt).toISOString() : null,
      model: done?.model ?? null,
      files: done?.files ?? [],
      commitSha: done?.commitSha ?? null,
      rubric: calibrated
        ? {
            rubric: calibrated.rubric!,
            at: calibrated.finishedAt ? new Date(calibrated.finishedAt).toISOString() : null,
            model: calibrated.model,
          }
        : null,
      rubricChanged: !!done?.rubric && !!calibrated && !sameRubric(done.rubric, calibrated.rubric),
      doneSince,
      auditStale: finishedAt !== null && doneSince > s.staleAfterPoints,
      running:
        later?.status === "running" && !stale
          ? { kind: later.kind, log: later.log, startedAt: new Date(later.startedAt).toISOString() }
          : null,
      error:
        later?.status === "failed"
          ? (later.error ?? (later.kind === "calibrate" ? "Calibrating failed." : "The audit failed."))
          : stale
            ? `The ${later.kind === "calibrate" ? "calibration" : "audit"} stopped without reporting. Run it again.`
            : null,
    };
  }
  return out;
}

/** Each sentinel's stars, for gradeOf. */
export function starsOf(states: SentinelStates): Record<string, number | null> {
  return Object.fromEntries(Object.values(states).map((s) => [s.id, s.stars]));
}
