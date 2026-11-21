import "server-only";

import { repository } from "@/lib/db";
import type { Rubric } from "@/lib/db/repository";
import { sentinel as findSentinel } from "@/lib/sentinels/roster";
import { sentinelsFor } from "@/lib/sentinels/service";
import { postPmMessage } from "./pm-messages";

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** The wording of one check in a rubric, or null when it has none by that id. */
export function checkText(rubric: Rubric | null | undefined, checkId: string): string | null {
  return rubric?.rungs.flatMap((r) => r.checks).find((c) => c.id === checkId)?.text ?? null;
}

/**
 * Tells the person in the board chat which rubric checks an agent found
 * wrong: the Sentinel, the check, why, its current text and the proposed
 * change, with an Approve / Decline proposal for each. Only flagged fixes
 * are told, once; each becomes proposed with the message. Nothing changes
 * until the person approves.
 */
export async function proposeRubricFixes(projectId: string, fixIds: string[]): Promise<void> {
  const repo = repository();
  const fixes = (await Promise.all(fixIds.map((id) => repo.rubricFix(id))))
    .filter((f): f is NonNullable<typeof f> => !!f && f.projectId === projectId && f.status === "flagged");
  if (fixes.length === 0) return;

  const states = await sentinelsFor(projectId);
  const lines = [
    fixes.length === 1
      ? "An agent found a rubric check that looks wrong. Nothing changes until you decide."
      : "Agents found rubric checks that look wrong. Nothing changes until you decide.",
  ];
  const proposals = fixes.map((f) => {
    const who = findSentinel(f.sentinel)?.who ?? f.sentinel;
    const current = checkText(states[f.sentinel]?.rubric?.rubric, f.checkId);
    lines.push("", `${who}, check ${code(f.checkId)}${f.ticketKey ? ` (found on ${f.ticketKey})` : ""}`);
    lines.push(`Why: ${f.problem}`);
    if (current) lines.push(`Now: ${current}`);
    lines.push(`Proposed: ${f.suggestion}`);
    return {
      summary: `Revise ${who}'s check ${f.checkId}`,
      action: { type: "revise_rubric_check", fix: f.id, current: current ?? undefined, proposed: f.suggestion },
      state: "proposed" as const,
    };
  });

  const posted = await postPmMessage(projectId, { content: lines.join("\n"), proposals });
  for (const f of fixes) await repo.updateRubricFix(f.id, { status: "proposed", messageId: posted.id });
}
