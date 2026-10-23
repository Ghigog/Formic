import { NextRequest } from "next/server";
import { columnFor } from "@/lib/domain/status";
import { budgetFor, minutesSetting } from "@/lib/budget/budget-for";
import { getRunTimeBudgetSettings } from "@/lib/user-settings";
import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import type { FormicEvent } from "@/lib/domain/events";
import {
  ACTIVITY_EVENTS,
  activityOf,
  appendActivity,
  type TicketActivity,
  type TicketView,
} from "@/lib/domain/ticket-view";

export const dynamic = "force-dynamic";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

/** A ticket's own view: the ticket, its plan, and what its agents did. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repo = repository();
  const project = await activeProject();
  if (!project || (await repo.projectOfCard(id)) !== project.id) return notFound();

  const detail = await repo.ticketDetail(id);
  const cards = await repo.boardCards(project.id);
  const card = cards.find((c) => c.id === id);
  if (!detail || !card) return notFound();

  const epic = cards.find((c) => c.id === detail.epicId);
  const events = await repo.ticketEvents(project.id, id, [...ACTIVITY_EVENTS], 300);
  let activity: TicketActivity[] = [];
  for (const e of events) {
    // The payload is the event as it was published.
    const item = activityOf(e.payload as FormicEvent, id, e.seq, e.at.toISOString());
    if (item) activity = appendActivity(activity, item);
  }

  // The same rule a run is held to: the column's override, else the person's setting.
  // `requested` rather than `value`, so mode Off reads as no budget, not the path's rail.
  const column = columnFor(card.status, card.stalledIn);
  const time = project.ownerId ? await getRunTimeBudgetSettings(project.ownerId) : null;
  const budget = budgetFor(
    time ? { minutes: minutesSetting(time) } : null,
    (await repo.columnOverrides(project.id))[column],
    card,
    "loop",
  );
  const usedMs = await repo.ticketRunMs(id);

  const view: TicketView = {
    card,
    epic: epic ? { id: epic.id, key: epic.key, title: epic.title, workType: epic.workType, bugSeverity: epic.bugSeverity } : null,
    description: detail.description,
    acceptanceCriteria: detail.acceptanceCriteria,
    branchName: detail.branchName,
    dependsOn: card.dependsOn.flatMap((depId) => {
      const dep = cards.find((c) => c.id === depId);
      return dep ? [{ id: dep.id, key: dep.key, title: dep.title, status: dep.status }] : [];
    }),
    plan: detail.plan,
    handoff: detail.handoff,
    followUps: detail.followUps,
    activity,
    usage: { usedMinutes: Math.round(usedMs / 60_000), budgetMinutes: budget.minutes.requested },
    canStop: card.status === "running" || !!detail.runnerJob || !!card.workingSince,
  };
  return Response.json(view);
}
