import "server-only";

import { repository } from "@/lib/db";
import type { AuditRecord, RubricCheck, RubricFix } from "@/lib/db/repository";
import { postPmMessage } from "@/lib/assistant/pm-messages";
import { sentinel as findSentinel } from "./roster";
import { sameRubric } from "./rubric";
import { onlyCheckChanged, reviseCheck, type CheckRevision } from "./rubric-fix";

/**
 * Landing a revision: the one place a rubric changes after calibrating, and
 * only for a fix the person approved. The new rubric is built from the old
 * one with just that check replaced and compared against it before anything
 * is saved, so a revision cannot touch another check, an id, a rung or the
 * context. Audits keep the rubric they were scored against.
 */

export type Landed = { ok: true; fix: RubricFix } | { ok: false; reason: string };

/** Whether a fix carries the person's approval. */
export function isApproved(fix: RubricFix): boolean {
  return (fix.status === "approved" || fix.status === "revising") && !!fix.approvedBy && !!fix.approvedAt;
}

/** The approved fix a revise run is working on: the one revising, else one approved. */
export async function fixOf(audit: AuditRecord): Promise<RubricFix | null> {
  const mine = (await repository().rubricFixesFor(audit.projectId, audit.sentinel)).filter(isApproved);
  return mine.find((f) => f.status === "revising") ?? mine[0] ?? null;
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** The paths a check's wording names. */
function pathsIn(check: RubricCheck): string[] {
  const found = `${check.text} ${check.how} ${check.command ?? ""}`.match(/[\w.-]+(?:\/[\w.-]+)+/g) ?? [];
  return [...new Set(found)];
}

async function tellFailed(fix: RubricFix, reason: string) {
  const who = findSentinel(fix.sentinel)?.who ?? fix.sentinel;
  await postPmMessage(fix.projectId, {
    content: `${who}'s check ${code(fix.checkId)} was not changed: ${reason} The rubric is as it was.`,
  });
}

/** Marks the fix failed, leaves the rubric alone, and tells the person. */
export async function failRevision(auditId: string, reason: string): Promise<Landed> {
  const audit = await repository().auditDetail(auditId);
  const fix = audit ? await fixOf(audit) : null;
  if (!fix) return { ok: false, reason: "No approved fix is waiting for this revision." };
  const failed = (await repository().updateRubricFix(fix.id, { status: "failed", error: reason })) ?? fix;
  await tellFailed(failed, reason);
  return { ok: false, reason };
}

/**
 * Applies a finished revise run's check to its Sentinel's rubric. Refused,
 * with nothing saved, for a fix that is not approved. A revision that changes
 * anything but its check fails the fix and leaves the rubric untouched.
 */
export async function landRevision(auditId: string, check: CheckRevision): Promise<Landed> {
  const repo = repository();
  const audit = await repo.auditDetail(auditId);
  if (!audit || audit.kind !== "revise") return { ok: false, reason: "This is not a revision." };
  const fix = await fixOf(audit);
  if (!fix) return { ok: false, reason: "No approved fix is waiting for this revision." };

  const calibration = (await repo.auditsFor(audit.projectId))
    .filter((a) => a.sentinel === audit.sentinel && a.kind === "calibrate" && a.status === "done" && a.rubric)
    .at(-1);
  if (!calibration?.rubric) return failRevision(auditId, "There is no rubric to revise.");
  // The check was revised against the rubric the run started with; a newer calibration voids it.
  if (audit.rubric && !sameRubric(audit.rubric, calibration.rubric)) {
    return failRevision(auditId, "The rubric was recalibrated meanwhile.");
  }

  const before = calibration.rubric;
  const old = before.rungs.flatMap((r) => r.checks).find((c) => c.id === fix.checkId);
  if (!old) return failRevision(auditId, `There is no check ${fix.checkId} in the rubric.`);
  const after = reviseCheck(before, fix.checkId, check);
  if (!onlyCheckChanged(before, after, fix.checkId)) {
    return failRevision(auditId, "the revision changed more than that one check.");
  }
  const next = after.rungs.flatMap((r) => r.checks).find((c) => c.id === fix.checkId)!;

  await repo.reviseCalibration(calibration.id, after);
  const applied = (await repo.updateRubricFix(fix.id, { status: "applied", before: old, after: next, appliedAt: new Date(), error: null })) ?? fix;

  const who = findSentinel(fix.sentinel)?.who ?? fix.sentinel;
  const paths = pathsIn(next);
  await postPmMessage(fix.projectId, {
    content: [
      `${who}'s check ${code(fix.checkId)} now reads: ${code(next.text)}`,
      ...(paths.length ? [`Paths: ${paths.map(code).join(", ")}.`] : []),
      "Every other check is as it was.",
    ].join("\n"),
    proposals: fix.ticketKey
      ? [
          {
            summary: `Close ${fix.ticketKey}, which was waiting on this rubric fix`,
            action: { type: "close_card", key: fix.ticketKey, reason: `${who}'s check ${fix.checkId} was fixed.` },
            state: "proposed" as const,
          },
        ]
      : undefined,
  });
  return { ok: true, fix: applied };
}
