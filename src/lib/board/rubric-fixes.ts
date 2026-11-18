import "server-only";

import { proposeRubricFixes } from "@/lib/assistant/rubric-fix-messages";
import { repository } from "@/lib/db";
import { checkRubricFixFlags, type RubricFixFlag } from "@/lib/sentinels/rubric-fix";
import { sentinelsFor } from "@/lib/sentinels/service";

/** A fix is open from the flag until the person's answer has been acted on. */
const OPEN = new Set(["flagged", "proposed", "approved", "revising"]);

/**
 * Keeps what an agent flagged as wrong in a Sentinel's rubric (RUBRIC_FIX_RULE)
 * on the ticket that found it, and has the PM bring it to the person. Only a
 * flag naming a check the Sentinel's rubric has is kept, and one already open
 * for the same Sentinel and check is not kept again. Nothing here touches a
 * rubric: only the person's approval lets a Sentinel revise a check.
 */
export async function recordRubricFixes(ticketId: string, flags: RubricFixFlag[], flaggedBy?: string): Promise<void> {
  const cleaned = checkRubricFixFlags(flags);
  if (cleaned.length === 0) return;
  const repo = repository();
  const ticket = await repo.ticketDetail(ticketId);
  if (!ticket) return;

  const states = await sentinelsFor(ticket.projectId);
  const open = (await repo.rubricFixesFor(ticket.projectId)).filter((f) => OPEN.has(f.status));
  const ids: string[] = [];
  for (const flag of cleaned) {
    const rubric = states[flag.sentinel]?.rubric?.rubric;
    if (!rubric?.rungs.some((r) => r.checks.some((c) => c.id === flag.check))) continue;
    if (open.some((f) => f.sentinel === flag.sentinel && f.checkId === flag.check)) continue;
    const fix = await repo.addRubricFix({
      projectId: ticket.projectId,
      sentinel: flag.sentinel,
      checkId: flag.check,
      problem: flag.problem,
      suggestion: flag.suggestion,
      ticketId: ticket.id,
      ticketKey: ticket.key,
      flaggedBy: flaggedBy ?? null,
    });
    open.push(fix);
    ids.push(fix.id);
  }
  if (ids.length > 0) await proposeRubricFixes(ticket.projectId, ids);
}
